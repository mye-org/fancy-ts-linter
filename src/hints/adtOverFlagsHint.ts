import * as O from 'fp-ts/lib/Option.js';
import * as RA from 'fp-ts/lib/ReadonlyArray.js';
import * as S from 'fp-ts/lib/string.js';
import type { AgentHint, BindingInfo, FieldInfo, RuleContext, TypeDeclInfo } from '../model/report.js';

export type HintRunner = (ctx: RuleContext) => ReadonlyArray<AgentHint>;

const flagFieldNames: ReadonlyArray<string> = [
  'status',
  'state',
  'mode',
  'kind',
  'type',
];

const checkMultiBooleanType = (td: TypeDeclInfo): ReadonlyArray<AgentHint> => {
  const boolFields = RA.filter((f: FieldInfo) => f.isBoolean)(td.fields);
  const optOrNullFields = RA.filter((f: FieldInfo) => f.isOptional || f.isNullable)(td.fields);
  const looseStatusFields = RA.filter(
    (f: FieldInfo) => f.isRawString && RA.elem(S.Eq)(f.name)(flagFieldNames),
  )(td.fields);

  const multiBoolHints: ReadonlyArray<AgentHint> =
    boolFields.length >= 2
      ? [
          {
            hintId: `adt-multi-bool-${td.name}`,
            category: 'adt-over-flags',
            priority: 'high',
            location: { line: td.location.line, column: td.location.column },
            evidence: `Type \`${td.name}\` has ${boolFields.length} boolean flags (${RA.map((f: FieldInfo) => f.name)(boolFields).join(', ')}), creating ${2 ** boolFields.length} possible flag combinations.`,
            suggestion: `Replace boolean flags on \`${td.name}\` with a Discriminated Union Sum Type (\`_tag\`) so illegal state combinations are unrepresentable.`,
            suggestedSignature: O.some(
              `export type ${td.name} = { readonly _tag: 'StateA'; ... } | { readonly _tag: 'StateB'; ... }`,
            ),
            researchQuestions: [
              `Which combinations of (${RA.map((f: FieldInfo) => f.name)(boolFields).join(', ')}) are actually valid in the domain?`,
              'Can each valid state carry only the fields relevant to that state?',
            ],
          },
        ]
      : [];

  const boolPlusOptHints: ReadonlyArray<AgentHint> =
    boolFields.length === 1 && RA.isNonEmpty(optOrNullFields)
      ? [
          {
            hintId: `adt-bool-opt-${td.name}`,
            category: 'adt-over-flags',
            priority: 'high',
            location: { line: td.location.line, column: td.location.column },
            evidence: `Type \`${td.name}\` pairs boolean flag \`${boolFields[0]?.name ?? ''}\` with optional/nullable field(s) (${RA.map((f: FieldInfo) => f.name)(optOrNullFields).join(', ')}).`,
            suggestion: `Split \`${td.name}\` into a Discriminated Union ADT where only the active variant carries the associated data.`,
            suggestedSignature: O.none,
            researchQuestions: [
              `Is \`${optOrNullFields[0]?.name ?? 'field'}\` only present when \`${boolFields[0]?.name ?? 'flag'}\` is true?`,
            ],
          },
        ]
      : [];

  const looseStatusHints: ReadonlyArray<AgentHint> = RA.map((f: FieldInfo): AgentHint => ({
    hintId: `adt-loose-status-${td.name}-${f.name}`,
    category: 'adt-over-flags',
    priority: 'medium',
    location: { line: td.location.line, column: td.location.column },
    evidence: `Field \`${td.name}.${f.name}\` is typed as raw \`string\` rather than a closed union or ADT.`,
    suggestion: `Replace raw \`${f.name}: string\` with a closed discriminated union or string-literal union.`,
    suggestedSignature: O.none,
    researchQuestions: [`What is the closed set of valid \`${f.name}\` states in the domain?`],
  }))(looseStatusFields);

  return [...multiBoolHints, ...boolPlusOptHints, ...looseStatusHints];
};

const isPredicateName = (name: string): boolean =>
  name.startsWith('is') || name.startsWith('has') || name.startsWith('can') || name.startsWith('should');

const checkBooleanParamBindings = (ctx: RuleContext): ReadonlyArray<AgentHint> =>
  RA.chain((b: BindingInfo): ReadonlyArray<AgentHint> => {
    if (isPredicateName(b.name)) {
      return [];
    }
    const type = ctx.checker.getTypeAtLocation(b.declaration);
    const sigs = type.getCallSignatures();
    const takesBool = RA.some((sig: ts.Signature) =>
      RA.some((p: ts.Symbol) => {
        const pt = ctx.checker.getTypeOfSymbolAtLocation(p, b.declaration);
        return (pt.flags & ts.TypeFlags.BooleanLike) !== 0;
      })(sig.getParameters()),
    )(sigs);

    return takesBool
      ? [
          {
            hintId: `adt-bool-param-${b.name}`,
            category: 'adt-over-flags',
            priority: 'high',
            location: { line: b.location.line, column: b.location.column },
            evidence: `Function \`${b.name}\` accepts a \`boolean\` flag parameter (${b.signature}).`,
            suggestion: `Replace the boolean mode/flag parameter with an explicit 2-variant ADT or separate domain-named functions.`,
            suggestedSignature: O.none,
            researchQuestions: [
              `What two distinct domain concepts does the \`boolean\` parameter in \`${b.name}\` represent?`,
            ],
          },
        ]
      : [];
  })(ctx.ir.bindings);

import * as ts from 'typescript';

export const detectAdtOverFlagsHints = ((ctx: RuleContext): ReadonlyArray<AgentHint> => [
  ...RA.chain(checkMultiBooleanType)(ctx.ir.typeDeclarations),
  ...checkBooleanParamBindings(ctx),
]) satisfies HintRunner;
