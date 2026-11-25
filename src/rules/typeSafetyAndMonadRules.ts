import { flow } from 'fp-ts/lib/function.js';
import * as O from 'fp-ts/lib/Option.js';
import * as RA from 'fp-ts/lib/ReadonlyArray.js';
import * as ts from 'typescript';
import type { BindingInfo, DiagnosticError, RuleContext, TypeDeclInfo } from '../model/report.js';

export type RuleRunner = (ctx: RuleContext) => ReadonlyArray<DiagnosticError>;

const collectAllNodes = (sf: ts.SourceFile) => (node: ts.Node): ReadonlyArray<ts.Node> => [
  node,
  ...RA.chain(collectAllNodes(sf))(node.getChildren(sf)),
];

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

const isAsConst = (n: ts.AsExpression): boolean =>
  ts.isTypeReferenceNode(n.type) &&
  ts.isIdentifier(n.type.typeName) &&
  n.type.typeName.text === 'const';

const isAnyTypeNode = (n: ts.Node): boolean =>
  n.kind === ts.SyntaxKind.AnyKeyword;

const checkTypeHoles =
  (ctx: RuleContext) =>
  (nodes: ReadonlyArray<ts.Node>): ReadonlyArray<DiagnosticError> => {
    const anyNodes = flow(
      RA.filter(isAnyTypeNode),
      RA.map((n: ts.Node) =>
        makeSafetyError(ctx)({
          ruleId: 'no-type-holes',
          category: 'type-safety',
          node: n,
          message: 'Explicit `any` type is forbidden.',
          fixGuidance:
            'Replace `any` with `unknown` and narrow with `ts-pattern` or a `Prism`/decoder.',
        }),
      ),
    )(nodes);

    const asNodes = flow(
      RA.filter(
        (n: ts.Node): n is ts.AsExpression => ts.isAsExpression(n) && !isAsConst(n),
      ),
      RA.map((n: ts.AsExpression) =>
        makeSafetyError(ctx)({
          ruleId: 'no-type-holes',
          category: 'type-safety',
          node: n,
          message:
            'Unsafe type assertion `as ...` is forbidden (`satisfies` and `as const` are allowed).',
          fixGuidance:
            'Use `satisfies` for type checking, `ts-pattern` for narrowing, or `newtype-ts` `iso`/`prism`.',
        }),
      ),
    )(nodes);

    const angleAssertions = flow(
      RA.filter(ts.isTypeAssertionExpression),
      RA.map((n: ts.TypeAssertion) =>
        makeSafetyError(ctx)({
          ruleId: 'no-type-holes',
          category: 'type-safety',
          node: n,
          message: 'Angle-bracket type assertion `<T>x` is forbidden.',
          fixGuidance: 'Use `satisfies` or proper type narrowing.',
        }),
      ),
    )(nodes);

    const nonNulls = flow(
      RA.filter(ts.isNonNullExpression),
      RA.map((n: ts.NonNullExpression) =>
        makeSafetyError(ctx)({
          ruleId: 'no-type-holes',
          category: 'type-safety',
          node: n,
          message: 'Non-null assertion `!` is forbidden.',
          fixGuidance: 'Lift nullable values into `fp-ts/Option` via `O.fromNullable`.',
        }),
      ),
    )(nodes);

    return [...anyNodes, ...asNodes, ...angleAssertions, ...nonNulls];
  };

const isInsideBoundaryLift = (ctx: RuleContext) => (node: ts.Node): boolean =>
  node.parent !== undefined &&
  (ctx.inspector.isBoundaryLiftCall(node.parent) || isInsideBoundaryLift(ctx)(node.parent));

const checkNullableBindings = (ctx: RuleContext): ReadonlyArray<DiagnosticError> =>
  RA.chain((b: BindingInfo): ReadonlyArray<DiagnosticError> => {
    const isBoundary = O.exists(
      (init: ts.Expression) => ctx.inspector.isBoundaryLiftCall(init),
    )(b.initializer);
    if (isBoundary) {
      return [];
    }
    const declType = ctx.checker.getTypeAtLocation(b.declaration);
    const sigs = declType.getCallSignatures();
    const hasNullableParam = RA.some((sig: ts.Signature) =>
      RA.some((p: ts.Symbol) =>
        ctx.inspector.hasNullablePart(ctx.checker.getTypeOfSymbolAtLocation(p, b.declaration)),
      )(sig.getParameters()),
    )(sigs);
    const hasNullableRet = RA.some((sig: ts.Signature) =>
      ctx.inspector.hasNullablePart(sig.getReturnType()),
    )(sigs);

    return hasNullableParam || hasNullableRet
      ? [
          makeSafetyError(ctx)({
            ruleId: 'no-nullable-types',
            category: 'monad',
            node: b.declaration,
            message: `Binding \`${b.name}\` uses \`null\` or \`undefined\` in its signature.`,
            fixGuidance:
              'Replace nullable types with `fp-ts/Option` (`O.Option<T>`) and lift external nullables via `O.fromNullable`.',
          }),
        ]
      : [];
  })(ctx.ir.bindings);

const checkNullableTypeDecls = (ctx: RuleContext): ReadonlyArray<DiagnosticError> =>
  RA.chain((td: TypeDeclInfo): ReadonlyArray<DiagnosticError> => {
    const nullableFields = RA.filter(
      (f: TypeDeclInfo['fields'][number]) => f.isNullable || f.isOptional,
    )(td.fields);
    return RA.isNonEmpty(nullableFields)
      ? [
          makeSafetyError(ctx)({
            ruleId: 'no-nullable-types',
            category: 'monad',
            node: td.node,
            message: `Type \`${td.name}\` has nullable/optional field(s): ${RA.map((f: TypeDeclInfo['fields'][number]) => f.name)(nullableFields).join(', ')}.`,
            fixGuidance:
              'Model optional fields with `O.Option<T>` or split states into a Discriminated Union ADT.',
          }),
        ]
      : [];
  })(ctx.ir.typeDeclarations);

const checkRawPromiseBindings = (ctx: RuleContext): ReadonlyArray<DiagnosticError> =>
  RA.chain((b: BindingInfo): ReadonlyArray<DiagnosticError> => {
    const isBoundary = O.exists(
      (init: ts.Expression) =>
        ctx.inspector.isBoundaryLiftCall(init) || isInsideBoundaryLift(ctx)(init),
    )(b.initializer);
    if (isBoundary) {
      return [];
    }
    const declType = ctx.checker.getTypeAtLocation(b.declaration);
    const sigs = declType.getCallSignatures();
    const hasPromise = RA.some(
      (sig: ts.Signature) =>
        ctx.inspector.hasRawPromise(sig.getReturnType()) ||
        RA.some((p: ts.Symbol) =>
          ctx.inspector.hasRawPromise(ctx.checker.getTypeOfSymbolAtLocation(p, b.declaration)),
        )(sig.getParameters()),
    )(sigs);

    return hasPromise
      ? [
          makeSafetyError(ctx)({
            ruleId: 'no-raw-promise',
            category: 'monad',
            node: b.declaration,
            message: `Binding \`${b.name}\` exposes raw \`Promise<T>\` instead of \`Task\` / \`TaskEither\`.`,
            fixGuidance:
              'Wrap Promises at the boundary with `TE.tryCatch` / `T.of` and type signatures with `Task<T>` or `TaskEither<E, A>`.',
          }),
        ]
      : [];
  })(ctx.ir.bindings);

const hasSpreadProperty = (obj: ts.ObjectLiteralExpression): boolean =>
  RA.some(ts.isSpreadAssignment)(obj.properties);

const hasNestedSpreadObject = (obj: ts.ObjectLiteralExpression): boolean =>
  hasSpreadProperty(obj) &&
  RA.some(
    (prop: ts.ObjectLiteralElementLike) =>
      ts.isPropertyAssignment(prop) &&
      ts.isObjectLiteralExpression(prop.initializer) &&
      hasSpreadProperty(prop.initializer),
  )(obj.properties);

const checkNestedSpreads =
  (ctx: RuleContext) =>
  (nodes: ReadonlyArray<ts.Node>): ReadonlyArray<DiagnosticError> =>
    flow(
      RA.filter(
        (n: ts.Node): n is ts.ObjectLiteralExpression =>
          ts.isObjectLiteralExpression(n) && hasNestedSpreadObject(n),
      ),
      RA.map((n: ts.ObjectLiteralExpression) =>
        makeSafetyError(ctx)({
          ruleId: 'no-nested-spread',
          category: 'optic',
          node: n,
          message: 'Nested object spread `{ ...a, b: { ...a.b, ... } }` is forbidden.',
          fixGuidance:
            'Use `monocle-ts` Optics (`Lens.fromPath`, `Lens.fromProp` + `modify`) for immutable nested updates.',
        }),
      ),
    )(nodes);

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
