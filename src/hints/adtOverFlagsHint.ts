import * as B from 'fp-ts/lib/boolean.js';
import { constant, flow } from 'fp-ts/lib/function.js';
import * as O from 'fp-ts/lib/Option.js';
import * as RA from 'fp-ts/lib/ReadonlyArray.js';
import * as S from 'fp-ts/lib/string.js';
import { Lens } from 'monocle-ts';
import * as ts from 'typescript';
import type { AgentHint, BindingInfo, FieldInfo, RuleContext, TypeDeclInfo } from '../model/report.js';

export type HintRunner = (ctx: RuleContext) => ReadonlyArray<AgentHint>;

type MultiBoolInput = {
  readonly td: TypeDeclInfo;
  readonly boolFields: ReadonlyArray<FieldInfo>;
};

type BoolPlusOptInput = {
  readonly td: TypeDeclInfo;
  readonly boolFields: ReadonlyArray<FieldInfo>;
  readonly optOrNullFields: ReadonlyArray<FieldInfo>;
};

type DeclCheckerInput = {
  readonly checker: ts.TypeChecker;
  readonly declaration: ts.VariableDeclaration;
};

const typeLineLens = Lens.fromPath<TypeDeclInfo>()(['location', 'line']);
const typeColLens = Lens.fromPath<TypeDeclInfo>()(['location', 'column']);
const bindingLineLens = Lens.fromPath<BindingInfo>()(['location', 'line']);
const bindingColLens = Lens.fromPath<BindingInfo>()(['location', 'column']);

const isBooleanField = (f: FieldInfo) => f.isBoolean;
const isOptOrNullField = (f: FieldInfo) => f.isOptional || f.isNullable;
const getFieldName = (f: FieldInfo) => f.name;

const isLooseStatusField = (f: FieldInfo) => {
  const flagFieldNames: ReadonlyArray<string> = ['status', 'state', 'mode', 'kind', 'type'];
  return f.isRawString && RA.elem(S.Eq)(f.name)(flagFieldNames);
};

const headFieldName = (fallback: string) =>
  flow(RA.head<FieldInfo>, O.map(getFieldName), O.getOrElse(constant(fallback)));

const makeMultiBoolHints = ({ td, boolFields }: MultiBoolInput) => {
  const hints: ReadonlyArray<AgentHint> = [
    {
      hintId: `adt-multi-bool-${td.name}`,
      category: 'adt-over-flags',
      priority: 'high',
      location: { line: typeLineLens.get(td), column: typeColLens.get(td) },
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
  ];
  return hints;
};

const makeBoolPlusOptHints = ({
  td,
  boolFields,
  optOrNullFields,
}: BoolPlusOptInput) => {
  const firstBoolName = headFieldName('')(boolFields);
  const firstBoolOrFlag = headFieldName('flag')(boolFields);
  const firstOptName = headFieldName('field')(optOrNullFields);
  const hints: ReadonlyArray<AgentHint> = [
    {
      hintId: `adt-bool-opt-${td.name}`,
      category: 'adt-over-flags',
      priority: 'high',
      location: { line: typeLineLens.get(td), column: typeColLens.get(td) },
      evidence: `Type \`${td.name}\` pairs boolean flag \`${firstBoolName}\` with optional/nullable field(s) (${RA.map(getFieldName)(optOrNullFields).join(', ')}).`,
      suggestion: `Split \`${td.name}\` into a Discriminated Union ADT where only the active variant carries the associated data.`,
      suggestedSignature: O.none,
      researchQuestions: [
        `Is \`${firstOptName}\` only present when \`${firstBoolOrFlag}\` is true?`,
      ],
    },
  ];
  return hints;
};

const makeLooseStatusHint =
  (td: TypeDeclInfo) =>
  (f: FieldInfo): AgentHint => ({
    hintId: `adt-loose-status-${td.name}-${f.name}`,
    category: 'adt-over-flags',
    priority: 'medium',
    location: { line: typeLineLens.get(td), column: typeColLens.get(td) },
    evidence: `Field \`${td.name}.${f.name}\` is typed as raw \`string\` rather than a closed union or ADT.`,
    suggestion: `Replace raw \`${f.name}: string\` with a closed discriminated union or string-literal union.`,
    suggestedSignature: O.none,
    researchQuestions: [`What is the closed set of valid \`${f.name}\` states in the domain?`],
  });

const checkMultiBooleanType = (td: TypeDeclInfo) => {
  const boolFields = RA.filter(isBooleanField)(td.fields);
  const optOrNullFields = RA.filter(isOptOrNullField)(td.fields);
  const looseStatusFields = RA.filter(isLooseStatusField)(td.fields);

  const multiBoolHints = B.match(
    RA.zero<AgentHint>,
    constant(makeMultiBoolHints({ td, boolFields })),
  )(boolFields.length >= 2);

  const boolPlusOptHints = B.match(
    RA.zero<AgentHint>,
    constant(makeBoolPlusOptHints({ td, boolFields, optOrNullFields })),
  )(boolFields.length === 1 && RA.isNonEmpty(optOrNullFields));

  const looseStatusHints = RA.map(makeLooseStatusHint(td))(looseStatusFields);

  return [...multiBoolHints, ...boolPlusOptHints, ...looseStatusHints];
};

const isPredicateName = (name: string) =>
  name.startsWith('is') || name.startsWith('has') || name.startsWith('can') || name.startsWith('should');

const paramIsBoolean =
  ({ checker, declaration }: DeclCheckerInput) =>
  (p: ts.Symbol) => {
    const pt = checker.getTypeOfSymbolAtLocation(p, declaration);
    return (pt.flags & ts.TypeFlags.BooleanLike) !== 0;
  };

const sigHasBooleanParam = (input: DeclCheckerInput) => (sig: ts.Signature) =>
  RA.some(paramIsBoolean(input))(sig.getParameters());

const makeBoolParamHint = (b: BindingInfo) => {
  const hints: ReadonlyArray<AgentHint> = [
    {
      hintId: `adt-bool-param-${b.name}`,
      category: 'adt-over-flags',
      priority: 'high',
      location: { line: bindingLineLens.get(b), column: bindingColLens.get(b) },
      evidence: `Function \`${b.name}\` accepts a \`boolean\` flag parameter (${b.signature}).`,
      suggestion: `Replace the boolean mode/flag parameter with an explicit 2-variant ADT or separate domain-named functions.`,
      suggestedSignature: O.none,
      researchQuestions: [
        `What two distinct domain concepts does the \`boolean\` parameter in \`${b.name}\` represent?`,
      ],
    },
  ];
  return hints;
};

const checkNonPredicateBinding = (ctx: RuleContext) => (b: BindingInfo) => {
  const type = ctx.checker.getTypeAtLocation(b.declaration);
  const sigs = type.getCallSignatures();
  const takesBool = RA.some(
    sigHasBooleanParam({ checker: ctx.checker, declaration: b.declaration }),
  )(sigs);
  return B.match(RA.zero<AgentHint>, constant(makeBoolParamHint(b)))(takesBool);
};

const checkBindingBooleanParam = (ctx: RuleContext) => (b: BindingInfo) =>
  B.match(constant(checkNonPredicateBinding(ctx)(b)), RA.zero<AgentHint>)(
    isPredicateName(b.name),
  );

const checkBooleanParamBindings = (ctx: RuleContext) =>
  RA.chain(checkBindingBooleanParam(ctx))(ctx.ir.bindings);

export const detectAdtOverFlagsHints = ((ctx: RuleContext): ReadonlyArray<AgentHint> => [
  ...RA.chain(checkMultiBooleanType)(ctx.ir.typeDeclarations),
  ...checkBooleanParamBindings(ctx),
]) satisfies HintRunner;
