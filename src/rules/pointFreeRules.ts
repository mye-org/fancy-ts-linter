import * as B from 'fp-ts/lib/boolean.js';
import { flow } from 'fp-ts/lib/function.js';
import * as O from 'fp-ts/lib/Option.js';
import * as RA from 'fp-ts/lib/ReadonlyArray.js';
import { Lens } from 'monocle-ts';
import * as ts from 'typescript';
import type { DiagnosticError, RuleContext } from '../model/report.js';

export type RuleRunner = (ctx: RuleContext) => ReadonlyArray<DiagnosticError>;

const paramLengthLens = Lens.fromPath<ts.ArrowFunction | ts.FunctionExpression>()([
  'parameters',
  'length',
]);

const propNameTextLens = Lens.fromPath<ts.PropertyAccessExpression>()(['name', 'text']);

const expandNode =
  ({ sf, tail }: { readonly sf: ts.SourceFile; readonly tail: ReadonlyArray<ts.Node> }) =>
  (head: ts.Node) =>
    [head, [...head.getChildren(sf), ...tail]] as const;

const stepNodeQueue = (sf: ts.SourceFile) => (queue: ReadonlyArray<ts.Node>) =>
  O.map(expandNode({ sf, tail: queue.slice(1) }))(RA.head(queue));

const collectAllNodes = (sf: ts.SourceFile) => (root: ts.Node): ReadonlyArray<ts.Node> =>
  RA.unfold([root], stepNodeQueue(sf));

type PfErrorInput = {
  readonly ruleId: string;
  readonly node: ts.Node;
  readonly message: string;
  readonly fixGuidance: string;
};

const makePfError =
  (ctx: RuleContext) =>
  ({ ruleId, node, message, fixGuidance }: PfErrorInput): DiagnosticError => ({
    ruleId,
    category: 'point-free',
    location: ctx.inspector.getLocation(ctx.sourceFile)(node),
    message,
    snippet: ctx.inspector.getSnippet(ctx.sourceFile)(node),
    fixGuidance,
  });

const dupParenExpr = (expr: ts.ParenthesizedExpression) =>
  [expr.expression, expr.expression] as const;

const stepParen = flow(O.fromPredicate(ts.isParenthesizedExpression), O.map(dupParenExpr));

const unwrapParens = (node: ts.Expression) =>
  O.getOrElse(() => node)(RA.last(RA.unfold(node, stepParen)));

const isCurriedWrapperParent = (cur: ts.Node) => (parent: ts.Node) =>
  ts.isSatisfiesExpression(parent) ||
  ts.isParenthesizedExpression(parent) ||
  (ts.isArrowFunction(parent) && parent.body === cur);

const dupNode = (n: ts.Node) => [n, n] as const;

const nextCurriedParent = (cur: ts.Node) =>
  O.map(dupNode)(
    O.chain(O.fromPredicate(isCurriedWrapperParent(cur)))(O.fromNullable(cur.parent)),
  );

const isTopLevelCurriedArrow = (node: ts.Node) => {
  const top = O.getOrElse(() => node)(RA.last(RA.unfold(node, nextCurriedParent)));
  return O.exists(ts.isVariableDeclaration)(O.fromNullable(top.parent));
};

const dupPropExpr = (expr: ts.PropertyAccessExpression) =>
  [expr.expression, expr.expression] as const;

const stepPropExpr = flow(O.fromPredicate(ts.isPropertyAccessExpression), O.map(dupPropExpr));

const isNamedIdentifier = (name: string) => (expr: ts.Expression) =>
  ts.isIdentifier(expr) && expr.text === name;

const isPropertyChainOn = (paramName: string) => (expr: ts.Expression) =>
  ts.isPropertyAccessExpression(expr) &&
  O.exists(isNamedIdentifier(paramName))(RA.last(RA.unfold(expr, stepPropExpr)));

const hasIdentifierParamName = (p: ts.ParameterDeclaration) => ts.isIdentifier(p.name);

const getIdentifierParamName = (arrow: ts.ArrowFunction) =>
  O.chain(O.fromPredicate(hasIdentifierParamName))(RA.head(arrow.parameters));

const isSingleExprArrow = (arrow: ts.ArrowFunction) =>
  paramLengthLens.get(arrow) === 1 && !ts.isBlock(arrow.body);

const isTrivialProjectionBody = (arrow: ts.ArrowFunction) => (param: ts.ParameterDeclaration) =>
  ts.isIdentifier(param.name) &&
  !ts.isBlock(arrow.body) &&
  isPropertyChainOn(param.name.text)(unwrapParens(arrow.body));

const isTrivialProjection = (arrow: ts.ArrowFunction) =>
  isSingleExprArrow(arrow) && O.exists(isTrivialProjectionBody(arrow))(getIdentifierParamName(arrow));

const isComparisonOrLogicOp = (kind: ts.SyntaxKind) =>
  [
    ts.SyntaxKind.EqualsEqualsEqualsToken,
    ts.SyntaxKind.ExclamationEqualsEqualsToken,
    ts.SyntaxKind.EqualsEqualsToken,
    ts.SyntaxKind.ExclamationEqualsToken,
    ts.SyntaxKind.LessThanToken,
    ts.SyntaxKind.LessThanEqualsToken,
    ts.SyntaxKind.GreaterThanToken,
    ts.SyntaxKind.GreaterThanEqualsToken,
    ts.SyntaxKind.AmpersandAmpersandToken,
    ts.SyntaxKind.BarBarToken,
  ].includes(kind);

const isSimpleLiteral = (e: ts.Expression) =>
  ts.isStringLiteral(e) ||
  ts.isNumericLiteral(e) ||
  e.kind === ts.SyntaxKind.TrueKeyword ||
  e.kind === ts.SyntaxKind.FalseKeyword;

const isSimpleLeafExpr = (paramName: string) => (e: ts.Expression) =>
  ts.isIdentifier(e) ||
  isSimpleLiteral(e) ||
  (ts.isPropertyAccessExpression(e) &&
    (isPropertyChainOn(paramName)(e) || ts.isIdentifier(e.expression)));

const isSimplePrefixOp = (e: ts.PrefixUnaryExpression) =>
  e.operator === ts.SyntaxKind.ExclamationToken || e.operator === ts.SyntaxKind.MinusToken;

const isSimplePrefixNode = (e: ts.Expression): e is ts.PrefixUnaryExpression =>
  ts.isPrefixUnaryExpression(e) && isSimplePrefixOp(e);

const isSimpleBinaryNode = (e: ts.Expression): e is ts.BinaryExpression =>
  ts.isBinaryExpression(e) && isComparisonOrLogicOp(e.operatorToken.kind);

const expandSimplePrefix = (tail: ReadonlyArray<ts.Expression>) => (e: ts.PrefixUnaryExpression) =>
  [true, [e.operand, ...tail]] as const;

const expandSimpleBinary = (tail: ReadonlyArray<ts.Expression>) => (e: ts.BinaryExpression) =>
  [true, [e.left, e.right, ...tail]] as const;

const stepSimpleExprHead =
  ({ paramName, tail }: { readonly paramName: string; readonly tail: ReadonlyArray<ts.Expression> }) =>
  (raw: ts.Expression) => {
    const e = unwrapParens(raw);
    return O.getOrElse(() =>
      O.getOrElse(() => [isSimpleLeafExpr(paramName)(e), tail] as const)(
        O.map(expandSimpleBinary(tail))(O.fromPredicate(isSimpleBinaryNode)(e)),
      ),
    )(O.map(expandSimplePrefix(tail))(O.fromPredicate(isSimplePrefixNode)(e)));
  };

const stepSimpleExprQueue =
  (paramName: string) => (queue: ReadonlyArray<ts.Expression>) =>
    O.map(stepSimpleExprHead({ paramName, tail: queue.slice(1) }))(RA.head(queue));

const isSimpleValueExpr = (paramName: string) => (expr: ts.Expression) =>
  RA.every(Boolean)(RA.unfold([expr], stepSimpleExprQueue(paramName)));

const isTrivialPredicateExpr = (paramName: string) => (body: ts.Expression) =>
  (ts.isBinaryExpression(body) &&
    isComparisonOrLogicOp(body.operatorToken.kind) &&
    isSimpleValueExpr(paramName)(body.left) &&
    isSimpleValueExpr(paramName)(body.right)) ||
  (ts.isPrefixUnaryExpression(body) &&
    body.operator === ts.SyntaxKind.ExclamationToken &&
    isSimpleValueExpr(paramName)(body.operand));

const isTrivialPredicateBody = (arrow: ts.ArrowFunction) => (param: ts.ParameterDeclaration) =>
  ts.isIdentifier(param.name) &&
  !ts.isBlock(arrow.body) &&
  isTrivialPredicateExpr(param.name.text)(unwrapParens(arrow.body));

const isTrivialPredicate = (arrow: ts.ArrowFunction) =>
  isSingleExprArrow(arrow) && O.exists(isTrivialPredicateBody(arrow))(getIdentifierParamName(arrow));

const isLazyBranchMethodName = (name: string) =>
  [
    'otherwise',
    'with',
    'match',
    'matchW',
    'getOrElse',
    'getOrElseW',
    'orElse',
    'orElseW',
    'fold',
    'foldW',
    'delay',
    'fromIO',
  ].includes(name);

const isLazyBranchCallee = (callee: ts.Expression) =>
  (ts.isPropertyAccessExpression(callee) && isLazyBranchMethodName(propNameTextLens.get(callee))) ||
  (ts.isIdentifier(callee) && isLazyBranchMethodName(callee.text));

const isLazyBranchCallParent = (parent: ts.Node) =>
  ts.isCallExpression(parent) && isLazyBranchCallee(parent.expression);

const isLazyBranchThunk = (arrow: ts.ArrowFunction) =>
  paramLengthLens.get(arrow) === 0 &&
  !ts.isBlock(arrow.body) &&
  O.exists(isLazyBranchCallParent)(O.fromNullable(arrow.parent));

const isAllowedInlineArrow = (n: ts.ArrowFunction | ts.FunctionExpression) =>
  ts.isArrowFunction(n) &&
  (isTrivialProjection(n) || isTrivialPredicate(n) || isLazyBranchThunk(n));

const isForbiddenInlineLambda = (n: ts.Node): n is ts.ArrowFunction | ts.FunctionExpression =>
  (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) &&
  !isTopLevelCurriedArrow(n) &&
  !isAllowedInlineArrow(n);

const makeInlineLambdaError = (ctx: RuleContext) => (n: ts.ArrowFunction | ts.FunctionExpression) =>
  makePfError(ctx)({
    ruleId: 'no-inline-lambda',
    node: n,
    message:
      'Inline anonymous lambda is forbidden; extract to a named private unary function or use an Optic.',
    fixGuidance:
      'Extract this lambda into a named top-level `const fn = ...` or replace property access with a `monocle-ts` Optic.',
  });

const checkInlineLambdas = (ctx: RuleContext) =>
  flow(RA.filter(isForbiddenInlineLambda), RA.map(makeInlineLambdaError(ctx)));

const isNonUnaryArrow = (n: ts.Node): n is ts.ArrowFunction | ts.FunctionExpression =>
  (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) &&
  paramLengthLens.get(n) !== 1 &&
  !(ts.isArrowFunction(n) && isLazyBranchThunk(n));

const arrowArityFixGuidance = (paramCount: number) =>
  B.match(
    () =>
      'Bundle parameters into a single named Domain/Input Record (`(input: FnInput) => ...`), or use at most a 2–3 level curry (`(config) => (input) => ...`) only when outer args are partially applied.',
    () =>
      'Replace 0-arg thunk with `constant(...)` (or use `() => expr` inside lazy branching combinators) or accept a single domain input parameter.',
  )(paramCount === 0);

const makeArrowArityError = (ctx: RuleContext) => (n: ts.ArrowFunction | ts.FunctionExpression) => {
  const paramCount = paramLengthLens.get(n);
  return makePfError(ctx)({
    ruleId: 'unary-arity-only',
    node: n,
    message: `Function must have arity 1 (single parameter), found ${paramCount} parameter(s).`,
    fixGuidance: arrowArityFixGuidance(paramCount),
  });
};

const checkArrowArity = (ctx: RuleContext) =>
  flow(RA.filter(isNonUnaryArrow), RA.map(makeArrowArityError(ctx)));

const isExprBody = (b: ts.ConciseBody): b is ts.Expression => !ts.isBlock(b);

const dupArrow = (a: ts.ArrowFunction) => [a, a] as const;

const stepCurryBody = flow(
  O.fromPredicate(isExprBody),
  O.map(unwrapParens),
  O.chain(O.fromPredicate(ts.isArrowFunction)),
  O.map(dupArrow),
);

const nextArrowBody = (arrow: ts.ArrowFunction) => stepCurryBody(arrow.body);

const countCurryDepth = (arrow: ts.ArrowFunction) =>
  1 + RA.unfold(arrow, nextArrowBody).length;

const isCurriedChainRoot = (n: ts.Node): n is ts.ArrowFunction =>
  ts.isArrowFunction(n) &&
  isTopLevelCurriedArrow(n) &&
  !O.exists(ts.isArrowFunction)(O.fromNullable(n.parent));

const isOverMaxCurryDepth = (n: ts.Node): n is ts.ArrowFunction =>
  isCurriedChainRoot(n) && countCurryDepth(n) > 3;

const makeCurryDepthError = (ctx: RuleContext) => (n: ts.ArrowFunction) => {
  const depth = countCurryDepth(n);
  return makePfError(ctx)({
    ruleId: 'max-curry-depth',
    node: n,
    message: `Curried chain of depth ${depth} exceeds the maximum allowed depth of 3.`,
    fixGuidance:
      'Collapse parameters into a single named input record (`(input: FnInput) => ...`), or keep at most 2–3 curried levels (`(ctx) => (input: FnInput) => ...`) when outer arguments are reused via partial application.',
  });
};

const checkCurryDepth = (ctx: RuleContext) =>
  flow(RA.filter(isOverMaxCurryDepth), RA.map(makeCurryDepthError(ctx)));

const isExternalDeclaration = (d: ts.Declaration) =>
  d.getSourceFile().fileName.includes('node_modules') || d.getSourceFile().isDeclarationFile;

const getFirstDeclaration = (sym: ts.Symbol) =>
  O.chain(RA.head)(O.fromNullable(sym.declarations));

const isExternalSymbol = flow(getFirstDeclaration, O.exists(isExternalDeclaration));

const isWithOrWhenCall = (expr: ts.Expression) =>
  ts.isPropertyAccessExpression(expr) &&
  (propNameTextLens.get(expr) === 'with' || propNameTextLens.get(expr) === 'when');

const isExemptMultiArgCallee = (ctx: RuleContext) => (call: ts.CallExpression) =>
  ctx.inspector.isFlowCall(call) ||
  isWithOrWhenCall(call.expression) ||
  O.exists(isExternalSymbol)(O.fromNullable(ctx.checker.getSymbolAtLocation(call.expression)));

const isForbiddenMultiArgCall = (ctx: RuleContext) => (n: ts.Node): n is ts.CallExpression =>
  ts.isCallExpression(n) && n.arguments.length > 1 && !isExemptMultiArgCallee(ctx)(n);

const makeCallArityError = (ctx: RuleContext) => (n: ts.CallExpression) =>
  makePfError(ctx)({
    ruleId: 'unary-arity-only',
    node: n,
    message: `Multi-argument call (${n.arguments.length} args) violates unary-arity rule.`,
    fixGuidance:
      'Refactor the target function to take a single named Input/Domain Record (`f({ ... })`), or at most a 2-level curry (`f(config)(input)`) if partially applied.',
  });

const checkCallArity = (ctx: RuleContext) =>
  flow(RA.filter(isForbiddenMultiArgCall(ctx)), RA.map(makeCallArityError(ctx)));

const isIdentifierNamed = (name: string) => (n: ts.Node) =>
  ts.isIdentifier(n) && n.text === name;

const referencesIdentifier = ({
  sf,
  name,
  node,
}: {
  readonly sf: ts.SourceFile;
  readonly name: string;
  readonly node: ts.Node;
}) => RA.some(isIdentifierNamed(name))(collectAllNodes(sf)(node));

const resolveAliasedSymbol = (checker: ts.TypeChecker) => (sym: ts.Symbol) =>
  B.match(
    () => sym,
    () => checker.getAliasedSymbol(sym),
  )((sym.flags & ts.SymbolFlags.Alias) !== 0);

const hasModuleSymbolFlag = (sym: ts.Symbol) =>
  (sym.flags & (ts.SymbolFlags.ValueModule | ts.SymbolFlags.NamespaceModule)) !== 0;

const isNamespaceReceiver = (checker: ts.TypeChecker) => (expr: ts.Expression) =>
  O.exists(flow(resolveAliasedSymbol(checker), hasModuleSymbolFlag))(
    O.fromNullable(checker.getSymbolAtLocation(expr)),
  );

const isMethodBindingWrapper = (checker: ts.TypeChecker) => (callee: ts.Expression) =>
  ts.isPropertyAccessExpression(callee) && !isNamespaceReceiver(checker)(callee.expression);

const isEtaBodyForParam =
  ({ ctx, paramName }: { readonly ctx: RuleContext; readonly paramName: string }) =>
  (body: ts.Expression) =>
    ts.isCallExpression(body) &&
    body.arguments.length === 1 &&
    !isMethodBindingWrapper(ctx.checker)(body.expression) &&
    O.exists(isIdentifierNamed(paramName))(RA.head(body.arguments)) &&
    !referencesIdentifier({ sf: ctx.sourceFile, name: paramName, node: body.expression });

const isEtaArrowWithParam =
  ({ ctx, arrow }: { readonly ctx: RuleContext; readonly arrow: ts.ArrowFunction }) =>
  (param: ts.ParameterDeclaration) =>
    ts.isIdentifier(param.name) &&
    !ts.isBlock(arrow.body) &&
    isEtaBodyForParam({ ctx, paramName: param.name.text })(unwrapParens(arrow.body));

const isEtaReducibleArrow = (ctx: RuleContext) => (arrow: ts.ArrowFunction) =>
  paramLengthLens.get(arrow) === 1 &&
  O.exists(isEtaArrowWithParam({ ctx, arrow }))(getIdentifierParamName(arrow));

const isEtaReducibleArrowNode = (ctx: RuleContext) => (n: ts.Node): n is ts.ArrowFunction =>
  ts.isArrowFunction(n) && isEtaReducibleArrow(ctx)(n);

const makeEtaError = (ctx: RuleContext) => (n: ts.ArrowFunction) =>
  makePfError(ctx)({
    ruleId: 'no-eta-reducible',
    node: n,
    message: 'Eta-reducible wrapper `x => f(x)` violates point-free style.',
    fixGuidance: 'Use the function `f` directly without the lambda wrapper.',
  });

const checkEtaReducible = (ctx: RuleContext) =>
  flow(RA.filter(isEtaReducibleArrowNode(ctx)), RA.map(makeEtaError(ctx)));

export const checkPointFreeRules = ((ctx: RuleContext): ReadonlyArray<DiagnosticError> => {
  const nodes = collectAllNodes(ctx.sourceFile)(ctx.sourceFile);
  return [
    ...checkInlineLambdas(ctx)(nodes),
    ...checkArrowArity(ctx)(nodes),
    ...checkCurryDepth(ctx)(nodes),
    ...checkCallArity(ctx)(nodes),
    ...checkEtaReducible(ctx)(nodes),
  ];
}) satisfies RuleRunner;
