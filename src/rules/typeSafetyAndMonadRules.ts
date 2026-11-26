import * as B from 'fp-ts/lib/boolean.js';
import { flow } from 'fp-ts/lib/function.js';
import * as O from 'fp-ts/lib/Option.js';
import * as RA from 'fp-ts/lib/ReadonlyArray.js';
import { Lens } from 'monocle-ts';
import * as ts from 'typescript';
import { iso } from 'newtype-ts';
import type { BindingInfo, DiagnosticError, RuleContext, TypeDeclInfo, DiagnosticMessage, FixGuidance, RuleId } from '../model/report.js';

const isoRuleId = iso<RuleId>();
const isoDiagMsg = iso<DiagnosticMessage>();
const isoFixGuidance = iso<FixGuidance>();

export type RuleRunner = (ctx: RuleContext) => ReadonlyArray<DiagnosticError>;

const boundaryLiftLens = Lens.fromPath<RuleContext>()(['inspector', 'isBoundaryLiftCall']);
const hasNullablePartLens = Lens.fromPath<RuleContext>()(['inspector', 'hasNullablePart']);
const irBindingsLens = Lens.fromPath<RuleContext>()(['ir', 'bindings']);
const hasRawPromiseLens = Lens.fromPath<RuleContext>()(['inspector', 'hasRawPromise']);

const expandNode =
  ({ sf, tail }: { readonly sf: ts.SourceFile; readonly tail: ReadonlyArray<ts.Node> }) =>
  (head: ts.Node) =>
    [head, [...head.getChildren(sf), ...tail]] as const;

const stepNodeQueue = (sf: ts.SourceFile) => (queue: ReadonlyArray<ts.Node>) =>
  O.map(expandNode({ sf, tail: queue.slice(1) }))(RA.head(queue));

const collectAllNodes = (sf: ts.SourceFile) => (root: ts.Node): ReadonlyArray<ts.Node> =>
  RA.unfold([root], stepNodeQueue(sf));

type SafetyErrorInput = {
  readonly ruleId: string;
  readonly category: DiagnosticError['category'];
  readonly node: ts.Node;
  readonly message: string;
  readonly fixGuidance: string;
};

const makeSafetyError =
  (ctx: RuleContext) =>
  ({ ruleId, category, node, message, fixGuidance }: SafetyErrorInput): DiagnosticError => ({    ruleId: isoRuleId.wrap(ruleId),
    category,
    location: ctx.inspector.getLocation(ctx.sourceFile)(node),
    message: isoDiagMsg.wrap(message),
    snippet: ctx.inspector.getSnippet(ctx.sourceFile)(node),
    fixGuidance: isoFixGuidance.wrap(fixGuidance),
  });

const isAsConst = (n: ts.AsExpression) =>
  ts.isTypeReferenceNode(n.type) &&
  ts.isIdentifier(n.type.typeName) &&
  n.type.typeName.text === 'const';

const isAnyTypeNode = (n: ts.Node) => n.kind === ts.SyntaxKind.AnyKeyword;

const isForbiddenAs = (n: ts.Node): n is ts.AsExpression =>
  ts.isAsExpression(n) && !isAsConst(n);

const makeAnyError = (ctx: RuleContext) => (n: ts.Node) =>
  makeSafetyError(ctx)({
    ruleId: 'no-type-holes',
    category: 'type-safety',
    node: n,
    message: 'Explicit `any` type is forbidden.',
    fixGuidance:
      'Replace `any` with `unknown` and narrow with `ts-pattern` or a `Prism`/decoder.',
  });

const makeAsError = (ctx: RuleContext) => (n: ts.AsExpression) =>
  makeSafetyError(ctx)({
    ruleId: 'no-type-holes',
    category: 'type-safety',
    node: n,
    message:
      'Unsafe type assertion `as ...` is forbidden (`satisfies` and `as const` are allowed).',
    fixGuidance:
      'Use `satisfies` for type checking, `ts-pattern` for narrowing, or `newtype-ts` `iso`/`prism`.',
  });

const makeAngleError = (ctx: RuleContext) => (n: ts.TypeAssertion) =>
  makeSafetyError(ctx)({
    ruleId: 'no-type-holes',
    category: 'type-safety',
    node: n,
    message: 'Angle-bracket type assertion `<T>x` is forbidden.',
    fixGuidance: 'Use `satisfies` or proper type narrowing.',
  });

const makeNonNullError = (ctx: RuleContext) => (n: ts.NonNullExpression) =>
  makeSafetyError(ctx)({
    ruleId: 'no-type-holes',
    category: 'type-safety',
    node: n,
    message: 'Non-null assertion `!` is forbidden.',
    fixGuidance: 'Lift nullable values into `fp-ts/Option` via `O.fromNullable`.',
  });

const checkTypeHoles = (ctx: RuleContext) => (nodes: ReadonlyArray<ts.Node>) => [
  ...flow(RA.filter(isAnyTypeNode), RA.map(makeAnyError(ctx)))(nodes),
  ...flow(RA.filter(isForbiddenAs), RA.map(makeAsError(ctx)))(nodes),
  ...flow(RA.filter(ts.isTypeAssertionExpression), RA.map(makeAngleError(ctx)))(nodes),
  ...flow(RA.filter(ts.isNonNullExpression), RA.map(makeNonNullError(ctx)))(nodes),
];

const getParentOpt = (node: ts.Node) => O.fromNullable(node.parent);

const dupParent = (parent: ts.Node) => [parent, parent] as const;

const nextParent = flow(getParentOpt, O.map(dupParent));

const ancestorsOf = (node: ts.Node) => RA.unfold(node, nextParent);

const isInsideBoundaryLift = (ctx: RuleContext) =>
  flow(ancestorsOf, RA.some(boundaryLiftLens.get(ctx)));

const isBoundaryBinding = (ctx: RuleContext) => (b: BindingInfo) =>
  O.exists(boundaryLiftLens.get(ctx))(b.initializer);

const isAnyBoundaryInit = (ctx: RuleContext) => (init: ts.Expression) =>
  boundaryLiftLens.get(ctx)(init) || isInsideBoundaryLift(ctx)(init);

const isAnyBoundaryBinding = (ctx: RuleContext) => (b: BindingInfo) =>
  O.exists(isAnyBoundaryInit(ctx))(b.initializer);

type DeclCheckInput = {
  readonly ctx: RuleContext;
  readonly decl: ts.VariableDeclaration;
};

const getParamType = ({ ctx, decl }: DeclCheckInput) => (p: ts.Symbol) =>
  ctx.checker.getTypeOfSymbolAtLocation(p, decl);

const paramHasNullablePart =
  (input: DeclCheckInput) =>
  (p: ts.Symbol) =>
    hasNullablePartLens.get(input.ctx)(getParamType(input)(p));

const sigHasNullableParam = (input: DeclCheckInput) => (sig: ts.Signature) =>
  RA.some(paramHasNullablePart(input))(sig.getParameters());

const sigHasNullableReturn = (ctx: RuleContext) => (sig: ts.Signature) =>
  hasNullablePartLens.get(ctx)(sig.getReturnType());

const getDeclType = (ctx: RuleContext) => (decl: ts.VariableDeclaration) =>
  ctx.checker.getTypeAtLocation(decl);

const hasNullableSig = (ctx: RuleContext) => (b: BindingInfo) => {
  const sigs = getDeclType(ctx)(b.declaration).getCallSignatures();
  return (
    RA.some(sigHasNullableParam({ ctx, decl: b.declaration }))(sigs) ||
    RA.some(sigHasNullableReturn(ctx))(sigs)
  );
};

const shouldFlagNullableBinding = (ctx: RuleContext) => (b: BindingInfo) =>
  !isBoundaryBinding(ctx)(b) && hasNullableSig(ctx)(b);

const makeNullableBindingError = (ctx: RuleContext) => (b: BindingInfo) =>
  makeSafetyError(ctx)({
    ruleId: 'no-nullable-types',
    category: 'monad',
    node: b.declaration,
    message: `Binding \`${b.name}\` uses \`null\` or \`undefined\` in its signature.`,
    fixGuidance:
      'Replace nullable types with `fp-ts/Option` (`O.Option<T>`) and lift external nullables via `O.fromNullable`.',
  });

const checkNullableBinding = (ctx: RuleContext) => (b: BindingInfo) =>
  B.match(
    (): ReadonlyArray<DiagnosticError> => [],
    () => [makeNullableBindingError(ctx)(b)],
  )(shouldFlagNullableBinding(ctx)(b));

const checkNullableBindings = (ctx: RuleContext) =>
  RA.chain(checkNullableBinding(ctx))(irBindingsLens.get(ctx));

const isNullableOrOptionalField = (f: TypeDeclInfo['fields'][number]) =>
  f.nullability !== 'required';

const getFieldName = (f: TypeDeclInfo['fields'][number]) => f.name;

type NullableTypeDeclErrorInput = {
  readonly td: TypeDeclInfo;
  readonly nullableFields: ReadonlyArray<TypeDeclInfo['fields'][number]>;
};

const makeNullableTypeDeclError =
  (ctx: RuleContext) =>
  ({ td, nullableFields }: NullableTypeDeclErrorInput) =>
    makeSafetyError(ctx)({
      ruleId: 'no-nullable-types',
      category: 'monad',
      node: td.node,
      message: `Type \`${td.name}\` has nullable/optional field(s): ${RA.map(getFieldName)(nullableFields).join(', ')}.`,
      fixGuidance:
        'Model optional fields with `O.Option<T>` or split states into a Discriminated Union ADT.',
    });

const checkNullableTypeDecl = (ctx: RuleContext) => (td: TypeDeclInfo) => {
  const nullableFields = RA.filter(isNullableOrOptionalField)(td.fields);
  return B.match(
    (): ReadonlyArray<DiagnosticError> => [],
    () => [makeNullableTypeDeclError(ctx)({ td, nullableFields })],
  )(RA.isNonEmpty(nullableFields));
};

const checkNullableTypeDecls = (ctx: RuleContext) =>
  RA.chain(checkNullableTypeDecl(ctx))(ctx.ir.typeDeclarations);

const paramHasRawPromise =
  (input: DeclCheckInput) =>
  (p: ts.Symbol) =>
    hasRawPromiseLens.get(input.ctx)(getParamType(input)(p));

const sigHasRawPromise = (input: DeclCheckInput) => (sig: ts.Signature) =>
  hasRawPromiseLens.get(input.ctx)(sig.getReturnType()) ||
  RA.some(paramHasRawPromise(input))(sig.getParameters());

const hasRawPromiseSig = (ctx: RuleContext) => (b: BindingInfo) => {
  const sigs = getDeclType(ctx)(b.declaration).getCallSignatures();
  return RA.some(sigHasRawPromise({ ctx, decl: b.declaration }))(sigs);
};

const shouldFlagRawPromiseBinding = (ctx: RuleContext) => (b: BindingInfo) =>
  !isAnyBoundaryBinding(ctx)(b) && hasRawPromiseSig(ctx)(b);

const makeRawPromiseBindingError = (ctx: RuleContext) => (b: BindingInfo) =>
  makeSafetyError(ctx)({
    ruleId: 'no-raw-promise',
    category: 'monad',
    node: b.declaration,
    message: `Binding \`${b.name}\` exposes raw \`Promise<T>\` instead of \`Task\` / \`TaskEither\`.`,
    fixGuidance:
      'Wrap Promises at the boundary with `TE.tryCatch` / `T.of` and type signatures with `Task<T>` or `TaskEither<E, A>`.',
  });

const checkRawPromiseBinding = (ctx: RuleContext) => (b: BindingInfo) =>
  B.match(
    (): ReadonlyArray<DiagnosticError> => [],
    () => [makeRawPromiseBindingError(ctx)(b)],
  )(shouldFlagRawPromiseBinding(ctx)(b));

const checkRawPromiseBindings = (ctx: RuleContext) =>
  RA.chain(checkRawPromiseBinding(ctx))(irBindingsLens.get(ctx));

const hasSpreadProperty = (obj: ts.ObjectLiteralExpression) =>
  RA.some(ts.isSpreadAssignment)(obj.properties);

const isNestedSpreadProp = (prop: ts.ObjectLiteralElementLike) =>
  ts.isPropertyAssignment(prop) &&
  ts.isObjectLiteralExpression(prop.initializer) &&
  hasSpreadProperty(prop.initializer);

const hasNestedSpreadObject = (obj: ts.ObjectLiteralExpression) =>
  hasSpreadProperty(obj) && RA.some(isNestedSpreadProp)(obj.properties);

const isNestedSpreadObjectNode = (n: ts.Node): n is ts.ObjectLiteralExpression =>
  ts.isObjectLiteralExpression(n) && hasNestedSpreadObject(n);

const makeNestedSpreadError = (ctx: RuleContext) => (n: ts.ObjectLiteralExpression) =>
  makeSafetyError(ctx)({
    ruleId: 'no-nested-spread',
    category: 'optic',
    node: n,
    message: 'Nested object spread `{ ...a, b: { ...a.b, ... } }` is forbidden.',
    fixGuidance:
      'Use `monocle-ts` Optics (`Lens.fromPath`, `Lens.fromProp` + `modify`) for immutable nested updates.',
  });

const checkNestedSpreads = (ctx: RuleContext) =>
  flow(RA.filter(isNestedSpreadObjectNode), RA.map(makeNestedSpreadError(ctx)));

export const checkTypeSafetyAndMonadRules = ((ctx: RuleContext): ReadonlyArray<DiagnosticError> => {
  const nodes = collectAllNodes(ctx.sourceFile)(ctx.sourceFile);
  return [
    ...ctx.tscErrors,
    ...checkTypeHoles(ctx)(nodes),
    ...checkNullableBindings(ctx),
    ...checkNullableTypeDecls(ctx),
    ...checkRawPromiseBindings(ctx),
    ...checkNestedSpreads(ctx)(nodes),
  ];
}) satisfies RuleRunner;
