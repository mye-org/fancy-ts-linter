import { constant, flow } from 'fp-ts/lib/function.js';
import * as B from 'fp-ts/lib/boolean.js';
import * as O from 'fp-ts/lib/Option.js';
import * as RA from 'fp-ts/lib/ReadonlyArray.js';
import type { ReadonlyNonEmptyArray } from 'fp-ts/lib/ReadonlyNonEmptyArray.js';
import * as ts from 'typescript';
import type { BindingInfo, DiagnosticError, RuleContext, TypeDeclInfo } from '../model/report.js';

export type RuleRunner = (ctx: RuleContext) => ReadonlyArray<DiagnosticError>;

const pairSelf = <A>(a: A) => [a, a] as const;

const stepNodeQueueNonEmpty = (sf: ts.SourceFile) => (q: ReadonlyNonEmptyArray<ts.Node>) =>
  [q[0], [...q[0].getChildren(sf), ...q.slice(1)]] as const;

const stepNodeQueue = (sf: ts.SourceFile) =>
  flow(O.fromPredicate(RA.isNonEmpty<ts.Node>), O.map(stepNodeQueueNonEmpty(sf)));

const collectAllNodes = (sf: ts.SourceFile) => (node: ts.Node) =>
  RA.unfold([node] satisfies ReadonlyArray<ts.Node>, stepNodeQueue(sf));

type SafetyErrorInput = {
  readonly ruleId: string;
  readonly category: DiagnosticError['category'];
  readonly node: ts.Node;
  readonly message: string;
  readonly fixGuidance: string;
};

const makeSafetyError =
  (ctx: RuleContext) =>
  ({ ruleId, category, node, message, fixGuidance }: SafetyErrorInput): DiagnosticError => ({
    ruleId,
    category,
    location: ctx.inspector.getLocation(ctx.sourceFile)(node),
    message,
    snippet: ctx.inspector.getSnippet(ctx.sourceFile)(node),
    fixGuidance,
  });

const isAsConst = (n: ts.AsExpression) =>
  ts.isTypeReferenceNode(n.type) &&
  ts.isIdentifier(n.type.typeName) &&
  n.type.typeName.text === 'const';

const isAnyTypeNode = (n: ts.Node) => n.kind === ts.SyntaxKind.AnyKeyword;

const makeAnyTypeError = (ctx: RuleContext) => (n: ts.Node) =>
  makeSafetyError(ctx)({
    ruleId: 'no-type-holes',
    category: 'type-safety',
    node: n,
    message: 'Explicit `any` type is forbidden.',
    fixGuidance:
      'Replace `any` with `unknown` and narrow with `ts-pattern` or a `Prism`/decoder.',
  });

const isDisallowedAsExpression = (n: ts.Node): n is ts.AsExpression =>
  ts.isAsExpression(n) && !isAsConst(n);

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

const makeAngleAssertionError = (ctx: RuleContext) => (n: ts.TypeAssertion) =>
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

const checkTypeHoles =
  (ctx: RuleContext) => (nodes: ReadonlyArray<ts.Node>) => [
    ...flow(RA.filter(isAnyTypeNode), RA.map(makeAnyTypeError(ctx)))(nodes),
    ...flow(RA.filter(isDisallowedAsExpression), RA.map(makeAsError(ctx)))(nodes),
    ...flow(RA.filter(ts.isTypeAssertionExpression), RA.map(makeAngleAssertionError(ctx)))(nodes),
    ...flow(RA.filter(ts.isNonNullExpression), RA.map(makeNonNullError(ctx)))(nodes),
  ];

const stepParentNode = (n: ts.Node) => O.map(pairSelf)(O.fromNullable(n.parent));

const getAncestors = (node: ts.Node) => RA.unfold(node, stepParentNode);

const isInsideBoundaryLift = (ctx: RuleContext) =>
  flow(getAncestors, RA.some(ctx.inspector.isBoundaryLiftCall));

const isBoundaryBinding = (ctx: RuleContext) => (b: BindingInfo) =>
  O.exists(ctx.inspector.isBoundaryLiftCall)(b.initializer);

const isNullableParam =
  ({ ctx, decl }: { readonly ctx: RuleContext; readonly decl: ts.VariableDeclaration }) =>
  (p: ts.Symbol) =>
    ctx.inspector.hasNullablePart(ctx.checker.getTypeOfSymbolAtLocation(p, decl));

const hasNullableParamInSig =
  ({ ctx, decl }: { readonly ctx: RuleContext; readonly decl: ts.VariableDeclaration }) =>
  (sig: ts.Signature) =>
    RA.some(isNullableParam({ ctx, decl }))(sig.getParameters());

const hasNullableRetInSig = (ctx: RuleContext) => (sig: ts.Signature) =>
  ctx.inspector.hasNullablePart(sig.getReturnType());

const hasNullableSig =
  ({ ctx, decl }: { readonly ctx: RuleContext; readonly decl: ts.VariableDeclaration }) =>
  (sig: ts.Signature) =>
    hasNullableParamInSig({ ctx, decl })(sig) || hasNullableRetInSig(ctx)(sig);

const hasNullableBindingSig = (ctx: RuleContext) => (b: BindingInfo) =>
  RA.some(hasNullableSig({ ctx, decl: b.declaration }))(
    ctx.checker.getTypeAtLocation(b.declaration).getCallSignatures(),
  );

const makeNullableBindingError = (ctx: RuleContext) => (b: BindingInfo) =>
  makeSafetyError(ctx)({
    ruleId: 'no-nullable-types',
    category: 'monad',
    node: b.declaration,
    message: `Binding \`${b.name}\` uses \`null\` or \`undefined\` in its signature.`,
    fixGuidance:
      'Replace nullable types with `fp-ts/Option` (`O.Option<T>`) and lift external nullables via `O.fromNullable`.',
  });

const checkSingleNullableBinding = (ctx: RuleContext) => (b: BindingInfo) =>
  B.match(
    constant([] satisfies ReadonlyArray<DiagnosticError>),
    flow(constant(b), makeNullableBindingError(ctx), RA.of),
  )(!isBoundaryBinding(ctx)(b) && hasNullableBindingSig(ctx)(b));

const checkNullableBindings = (ctx: RuleContext) =>
  RA.chain(checkSingleNullableBinding(ctx))(ctx.ir.bindings);

const isNullableOrOptionalField = (f: TypeDeclInfo['fields'][number]) =>
  f.isNullable || f.isOptional;

const getFieldName = (f: TypeDeclInfo['fields'][number]) => f.name;

const makeNullableTypeDeclError =
  ({ ctx, td }: { readonly ctx: RuleContext; readonly td: TypeDeclInfo }) =>
  (nullableFields: ReadonlyNonEmptyArray<TypeDeclInfo['fields'][number]>) => [
    makeSafetyError(ctx)({
      ruleId: 'no-nullable-types',
      category: 'monad',
      node: td.node,
      message: `Type \`${td.name}\` has nullable/optional field(s): ${RA.map(getFieldName)(nullableFields).join(', ')}.`,
      fixGuidance:
        'Model optional fields with `O.Option<T>` or split states into a Discriminated Union ADT.',
    }),
  ];

const checkSingleNullableTypeDecl = (ctx: RuleContext) => (td: TypeDeclInfo) =>
  flow(
    RA.filter(isNullableOrOptionalField),
    O.fromPredicate(RA.isNonEmpty),
    O.match(
      constant([] satisfies ReadonlyArray<DiagnosticError>),
      makeNullableTypeDeclError({ ctx, td }),
    ),
  )(td.fields);

const checkNullableTypeDecls = (ctx: RuleContext) =>
  RA.chain(checkSingleNullableTypeDecl(ctx))(ctx.ir.typeDeclarations);

const isBoundaryOrInsideLift = (ctx: RuleContext) => (init: ts.Expression) =>
  ctx.inspector.isBoundaryLiftCall(init) || isInsideBoundaryLift(ctx)(init);

const isPromiseBoundaryBinding = (ctx: RuleContext) => (b: BindingInfo) =>
  O.exists(isBoundaryOrInsideLift(ctx))(b.initializer);

const isPromiseParam =
  ({ ctx, decl }: { readonly ctx: RuleContext; readonly decl: ts.VariableDeclaration }) =>
  (p: ts.Symbol) =>
    ctx.inspector.hasRawPromise(ctx.checker.getTypeOfSymbolAtLocation(p, decl));

const hasPromiseInSig =
  ({ ctx, decl }: { readonly ctx: RuleContext; readonly decl: ts.VariableDeclaration }) =>
  (sig: ts.Signature) =>
    ctx.inspector.hasRawPromise(sig.getReturnType()) ||
    RA.some(isPromiseParam({ ctx, decl }))(sig.getParameters());

const hasRawPromiseSig = (ctx: RuleContext) => (b: BindingInfo) =>
  RA.some(hasPromiseInSig({ ctx, decl: b.declaration }))(
    ctx.checker.getTypeAtLocation(b.declaration).getCallSignatures(),
  );

const makeRawPromiseError = (ctx: RuleContext) => (b: BindingInfo) =>
  makeSafetyError(ctx)({
    ruleId: 'no-raw-promise',
    category: 'monad',
    node: b.declaration,
    message: `Binding \`${b.name}\` exposes raw \`Promise<T>\` instead of \`Task\` / \`TaskEither\`.`,
    fixGuidance:
      'Wrap Promises at the boundary with `TE.tryCatch` / `T.of` and type signatures with `Task<T>` or `TaskEither<E, A>`.',
  });

const checkSingleRawPromiseBinding = (ctx: RuleContext) => (b: BindingInfo) =>
  B.match(
    constant([] satisfies ReadonlyArray<DiagnosticError>),
    flow(constant(b), makeRawPromiseError(ctx), RA.of),
  )(!isPromiseBoundaryBinding(ctx)(b) && hasRawPromiseSig(ctx)(b));

const checkRawPromiseBindings = (ctx: RuleContext) =>
  RA.chain(checkSingleRawPromiseBinding(ctx))(ctx.ir.bindings);

const hasSpreadProperty = (obj: ts.ObjectLiteralExpression) =>
  RA.some(ts.isSpreadAssignment)(obj.properties);

const isSpreadPropAssignment = (prop: ts.ObjectLiteralElementLike) =>
  ts.isPropertyAssignment(prop) &&
  ts.isObjectLiteralExpression(prop.initializer) &&
  hasSpreadProperty(prop.initializer);

const hasNestedSpreadObject = (obj: ts.ObjectLiteralExpression) =>
  hasSpreadProperty(obj) && RA.some(isSpreadPropAssignment)(obj.properties);

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

const applySafetyAndMonadChecks =
  (ctx: RuleContext) => (nodes: ReadonlyArray<ts.Node>) => [
    ...ctx.tscErrors,
    ...checkTypeHoles(ctx)(nodes),
    ...checkNullableBindings(ctx),
    ...checkNullableTypeDecls(ctx),
    ...checkRawPromiseBindings(ctx),
    ...checkNestedSpreads(ctx)(nodes),
  ];

const runSafetyAndMonadChecks = (ctx: RuleContext) =>
  applySafetyAndMonadChecks(ctx)(collectAllNodes(ctx.sourceFile)(ctx.sourceFile));

const identityCtx = (ctx: RuleContext) => ctx;

export const checkTypeSafetyAndMonadRules = flow(
  identityCtx,
  runSafetyAndMonadChecks,
) satisfies RuleRunner;
