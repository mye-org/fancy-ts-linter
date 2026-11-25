import * as B from 'fp-ts/lib/boolean.js';
import { constant, flow } from 'fp-ts/lib/function.js';
import * as O from 'fp-ts/lib/Option.js';
import * as RA from 'fp-ts/lib/ReadonlyArray.js';
import * as S from 'fp-ts/lib/string.js';
import * as ts from 'typescript';
import type { AgentHint, BindingInfo, FieldInfo, RuleContext, TypeDeclInfo } from '../model/report.js';

export type HintRunner = (ctx: RuleContext) => ReadonlyArray<AgentHint>;

type BoolOptPair = {
  readonly boolFields: ReadonlyArray<FieldInfo>;
  readonly optOrNullFields: ReadonlyArray<FieldInfo>;
};

type ParamCheckContext = {
  readonly checker: ts.TypeChecker;
  readonly decl: ts.Node;
};

const isBooleanField = (f: FieldInfo) => f.isBoolean;
const isOptOrNullField = (f: FieldInfo) => f.isOptional || f.isNullable;
const isLooseStatusField = (f: FieldInfo) =>
  f.isRawString && RA.elem(S.Eq)(f.name)(['status', 'state', 'mode', 'kind', 'type']);
const getFieldName = (f: FieldInfo) => f.name;

const firstFieldNameOr = (fallback: string) =>
  flow(RA.head<FieldInfo>, O.map(getFieldName), O.getOrElse(constant(fallback)));

const checkMultiBoolFieldsFor =
  (td: TypeDeclInfo) =>
  (boolFields: ReadonlyArray<FieldInfo>) =>
    B.match(
      constant(RA.zero<AgentHint>()),
      constant([
        {
          hintId: `adt-multi-bool-${td.name}`,
          category: 'adt-over-flags' as const,
          priority: 'high' as const,
          location: { line: td.location.line, column: td.location.column },
          evidence: `Type \`${td.name}\` has ${boolFields.length} boolean flags (${RA.map(getFieldName)(boolFields).join(', ')}), creating ${2 ** boolFields.length} possible flag combinations.`,
          suggestion: `Replace boolean flags on \`${td.name}\` with a Discriminated Union Sum Type (\`_tag\`) so illegal state combinations are unrepresentable.`,
          suggestedSignature: O.some(
            `export type ${td.name} = { readonly _tag: 'StateA'; ... } | { readonly _tag: 'StateB'; ... }`,
          ),
          researchQuestions: [
            `Which combinations of (${RA.map(getFieldName)(boolFields).join(', ')}) are actually valid in the domain?`,
            'Can each valid state carry only the fields relevant to that state?',
          ],
        },
      ]),
    )(boolFields.length >= 2);

const getTdFields = (td: TypeDeclInfo) => td.fields;

const checkMultiBoolFields = (td: TypeDeclInfo) =>
  flow(getTdFields, RA.filter(isBooleanField), checkMultiBoolFieldsFor(td))(td);

const checkBoolPlusOptPair =
  (td: TypeDeclInfo) =>
  (pair: BoolOptPair) =>
    B.match(
      constant(RA.zero<AgentHint>()),
      constant([
        {
          hintId: `adt-bool-opt-${td.name}`,
          category: 'adt-over-flags' as const,
          priority: 'high' as const,
          location: { line: td.location.line, column: td.location.column },
          evidence: `Type \`${td.name}\` pairs boolean flag \`${firstFieldNameOr('')(pair.boolFields)}\` with optional/nullable field(s) (${RA.map(getFieldName)(pair.optOrNullFields).join(', ')}).`,
          suggestion: `Split \`${td.name}\` into a Discriminated Union ADT where only the active variant carries the associated data.`,
          suggestedSignature: O.none,
          researchQuestions: [
            `Is \`${firstFieldNameOr('field')(pair.optOrNullFields)}\` only present when \`${firstFieldNameOr('flag')(pair.boolFields)}\` is true?`,
          ],
        },
      ]),
    )(pair.boolFields.length === 1 && RA.isNonEmpty(pair.optOrNullFields));

const checkBoolPlusOptFields = (td: TypeDeclInfo) =>
  checkBoolPlusOptPair(td)({
    boolFields: RA.filter(isBooleanField)(td.fields),
    optOrNullFields: RA.filter(isOptOrNullField)(td.fields),
  });

const buildLooseStatusHint =
  (td: TypeDeclInfo) =>
  (f: FieldInfo): AgentHint => ({
    hintId: `adt-loose-status-${td.name}-${f.name}`,
    category: 'adt-over-flags',
    priority: 'medium',
    location: { line: td.location.line, column: td.location.column },
    evidence: `Field \`${td.name}.${f.name}\` is typed as raw \`string\` rather than a closed union or ADT.`,
    suggestion: `Replace raw \`${f.name}: string\` with a closed discriminated union or string-literal union.`,
    suggestedSignature: O.none,
    researchQuestions: [`What is the closed set of valid \`${f.name}\` states in the domain?`],
  });

const checkLooseStatusFields = (td: TypeDeclInfo) =>
  flow(getTdFields, RA.filter(isLooseStatusField), RA.map(buildLooseStatusHint(td)))(td);

const checkMultiBooleanType = (td: TypeDeclInfo) => [
  ...checkMultiBoolFields(td),
  ...checkBoolPlusOptFields(td),
  ...checkLooseStatusFields(td),
];

const isPredicateName = (name: string) =>
  name.startsWith('is') || name.startsWith('has') || name.startsWith('can') || name.startsWith('should');

const isNonPredicateBinding = (b: BindingInfo) => !isPredicateName(b.name);

const isBooleanSymbol =
  (paramCtx: ParamCheckContext) =>
  (p: ts.Symbol) =>
    (paramCtx.checker.getTypeOfSymbolAtLocation(p, paramCtx.decl).flags &
      ts.TypeFlags.BooleanLike) !==
    0;

const sigTakesBool =
  (paramCtx: ParamCheckContext) =>
  (sig: ts.Signature) =>
    RA.some(isBooleanSymbol(paramCtx))(sig.getParameters());

const buildBoolParamHint = (b: BindingInfo) => [
  {
    hintId: `adt-bool-param-${b.name}`,
    category: 'adt-over-flags' as const,
    priority: 'high' as const,
    location: { line: b.location.line, column: b.location.column },
    evidence: `Function \`${b.name}\` accepts a \`boolean\` flag parameter (${b.signature}).`,
    suggestion: `Replace the boolean mode/flag parameter with an explicit 2-variant ADT or separate domain-named functions.`,
    suggestedSignature: O.none,
    researchQuestions: [
      `What two distinct domain concepts does the \`boolean\` parameter in \`${b.name}\` represent?`,
    ],
  },
];

const checkNonPredicateBinding =
  (ctx: RuleContext) =>
  (b: BindingInfo) =>
    B.match(
      constant(RA.zero<AgentHint>()),
      constant(buildBoolParamHint(b)),
    )(
      RA.some(sigTakesBool({ checker: ctx.checker, decl: b.declaration }))(
        ctx.checker.getTypeAtLocation(b.declaration).getCallSignatures(),
      ),
    );

const checkBindingBoolParam = (ctx: RuleContext) =>
  flow(
    O.fromPredicate(isNonPredicateBinding),
    O.match(constant(RA.zero<AgentHint>()), checkNonPredicateBinding(ctx)),
  );

const checkBooleanParamBindings = (ctx: RuleContext) =>
  RA.chain(checkBindingBoolParam(ctx))(ctx.ir.bindings);

const runAdtOverFlags = (ctx: RuleContext) => [
  ...RA.chain(checkMultiBooleanType)(ctx.ir.typeDeclarations),
  ...checkBooleanParamBindings(ctx),
];

const identityCtx = (ctx: RuleContext) => ctx;

export const detectAdtOverFlagsHints = flow(
  identityCtx,
  runAdtOverFlags,
) satisfies HintRunner;
