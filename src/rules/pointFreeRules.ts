import { flow } from 'fp-ts/lib/function.js';
import * as O from 'fp-ts/lib/Option.js';
import * as RA from 'fp-ts/lib/ReadonlyArray.js';
import * as ts from 'typescript';
import type { DiagnosticError, RuleContext } from '../model/report.js';

export type RuleRunner = (ctx: RuleContext) => ReadonlyArray<DiagnosticError>;

const collectAllNodes = (sf: ts.SourceFile) => (node: ts.Node): ReadonlyArray<ts.Node> => [
  node,
  ...RA.chain(collectAllNodes(sf))(node.getChildren(sf)),
];

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

const isTopLevelCurriedArrow = (node: ts.Node): boolean => {
  const parent = node.parent;
  return (
    parent !== undefined &&
    (ts.isVariableDeclaration(parent) ||
      ((ts.isSatisfiesExpression(parent) || ts.isParenthesizedExpression(parent)) &&
        isTopLevelCurriedArrow(parent)) ||
      (ts.isArrowFunction(parent) && parent.body === node && isTopLevelCurriedArrow(parent)))
  );
};

const isPropertyChainOn =
  (paramName: string) =>
  (expr: ts.Expression): boolean =>
    ts.isPropertyAccessExpression(expr) &&
    ((ts.isIdentifier(expr.expression) && expr.expression.text === paramName) ||
      isPropertyChainOn(paramName)(expr.expression));

const isTrivialProjection = (arrow: ts.ArrowFunction): boolean => {
  if (arrow.parameters.length !== 1 || ts.isBlock(arrow.body)) {
    return false;
  }
  const param = arrow.parameters[0];
  if (param === undefined || !ts.isIdentifier(param.name)) {
    return false;
  }
  return isPropertyChainOn(param.name.text)(unwrapParens(arrow.body));
};

const comparisonAndLogicOps: ReadonlyArray<ts.SyntaxKind> = [
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
];

const isSimpleValueExpr =
  (paramName: string) =>
  (expr: ts.Expression): boolean => {
    const e = unwrapParens(expr);
    if (ts.isIdentifier(e)) {
      return true;
    }
    if (
      ts.isStringLiteral(e) ||
      ts.isNumericLiteral(e) ||
      e.kind === ts.SyntaxKind.TrueKeyword ||
      e.kind === ts.SyntaxKind.FalseKeyword
    ) {
      return true;
    }
    if (ts.isPropertyAccessExpression(e)) {
      return isPropertyChainOn(paramName)(e) || ts.isIdentifier(e.expression);
    }
    if (
      ts.isPrefixUnaryExpression(e) &&
      (e.operator === ts.SyntaxKind.ExclamationToken || e.operator === ts.SyntaxKind.MinusToken)
    ) {
      return isSimpleValueExpr(paramName)(e.operand);
    }
    if (ts.isBinaryExpression(e) && comparisonAndLogicOps.includes(e.operatorToken.kind)) {
      return isSimpleValueExpr(paramName)(e.left) && isSimpleValueExpr(paramName)(e.right);
    }
    return false;
  };

const isTrivialPredicate = (arrow: ts.ArrowFunction): boolean => {
  if (arrow.parameters.length !== 1 || ts.isBlock(arrow.body)) {
    return false;
  }
  const param = arrow.parameters[0];
  if (param === undefined || !ts.isIdentifier(param.name)) {
    return false;
  }
  const body = unwrapParens(arrow.body);
  return (
    (ts.isBinaryExpression(body) &&
      comparisonAndLogicOps.includes(body.operatorToken.kind) &&
      isSimpleValueExpr(param.name.text)(body.left) &&
      isSimpleValueExpr(param.name.text)(body.right)) ||
    (ts.isPrefixUnaryExpression(body) &&
      body.operator === ts.SyntaxKind.ExclamationToken &&
      isSimpleValueExpr(param.name.text)(body.operand))
  );
};

const lazyBranchMethods: ReadonlyArray<string> = [
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
];

const isLazyBranchThunk = (arrow: ts.ArrowFunction): boolean => {
  if (arrow.parameters.length !== 0 || ts.isBlock(arrow.body)) {
    return false;
  }
  const parent = arrow.parent;
  if (parent === undefined || !ts.isCallExpression(parent)) {
    return false;
  }
  const callee = parent.expression;
  if (ts.isPropertyAccessExpression(callee)) {
    return lazyBranchMethods.includes(callee.name.text);
  }
  if (ts.isIdentifier(callee)) {
    return lazyBranchMethods.includes(callee.text);
  }
  return false;
};

const isAllowedInlineArrow = (n: ts.ArrowFunction | ts.FunctionExpression): boolean =>
  ts.isArrowFunction(n) &&
  (isTrivialProjection(n) || isTrivialPredicate(n) || isLazyBranchThunk(n));

const checkInlineLambdas =
  (ctx: RuleContext) =>
  (nodes: ReadonlyArray<ts.Node>): ReadonlyArray<DiagnosticError> =>
    flow(
      RA.filter(
        (n: ts.Node): n is ts.ArrowFunction | ts.FunctionExpression =>
          (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) &&
          !isTopLevelCurriedArrow(n) &&
          !isAllowedInlineArrow(n),
      ),
      RA.map((n: ts.ArrowFunction | ts.FunctionExpression) =>
        makePfError(ctx)({
          ruleId: 'no-inline-lambda',
          node: n,
          message:
            'Inline anonymous lambda is forbidden; extract to a named private unary function or use an Optic.',
          fixGuidance:
            'Extract this lambda into a named top-level `const fn = ...` or replace property access with a `monocle-ts` Optic.',
        }),
      ),
    )(nodes);

const checkArrowArity =
  (ctx: RuleContext) =>
  (nodes: ReadonlyArray<ts.Node>): ReadonlyArray<DiagnosticError> =>
    flow(
      RA.filter(
        (n: ts.Node): n is ts.ArrowFunction | ts.FunctionExpression =>
          (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) &&
          n.parameters.length !== 1 &&
          !(ts.isArrowFunction(n) && isLazyBranchThunk(n)),
      ),
      RA.map((n: ts.ArrowFunction | ts.FunctionExpression) =>
        makePfError(ctx)({
          ruleId: 'unary-arity-only',
          node: n,
          message: `Function must have arity 1 (single parameter), found ${n.parameters.length} parameter(s).`,
          fixGuidance:
            n.parameters.length === 0
              ? 'Replace 0-arg thunk with `constant(...)` (or use `() => expr` inside lazy branching combinators) or accept a single domain input parameter.'
              : 'Bundle parameters into a single named Domain/Input Record (`(input: FnInput) => ...`), or use at most a 2–3 level curry (`(config) => (input) => ...`) only when outer args are partially applied.',
        }),
      ),
    )(nodes);

const MAX_CURRY_DEPTH = 3;

const unwrapParens = (node: ts.Expression): ts.Expression =>
  ts.isParenthesizedExpression(node) ? unwrapParens(node.expression) : node;

const countCurryDepth = (arrow: ts.ArrowFunction): number => {
  if (ts.isBlock(arrow.body)) {
    return 1;
  }
  const body = unwrapParens(arrow.body);
  return ts.isArrowFunction(body) ? 1 + countCurryDepth(body) : 1;
};

const isCurriedChainRoot = (n: ts.Node): n is ts.ArrowFunction =>
  ts.isArrowFunction(n) &&
  isTopLevelCurriedArrow(n) &&
  !(n.parent !== undefined && ts.isArrowFunction(n.parent));

const checkCurryDepth =
  (ctx: RuleContext) =>
  (nodes: ReadonlyArray<ts.Node>): ReadonlyArray<DiagnosticError> =>
    flow(
      RA.filter(
        (n: ts.Node): n is ts.ArrowFunction =>
          isCurriedChainRoot(n) && countCurryDepth(n) > MAX_CURRY_DEPTH,
      ),
      RA.map((n: ts.ArrowFunction) => {
        const depth = countCurryDepth(n);
        return makePfError(ctx)({
          ruleId: 'max-curry-depth',
          node: n,
          message: `Curried chain of depth ${depth} exceeds the maximum allowed depth of ${MAX_CURRY_DEPTH}.`,
          fixGuidance:
            'Collapse parameters into a single named input record (`(input: FnInput) => ...`), or keep at most 2–3 curried levels (`(ctx) => (input: FnInput) => ...`) when outer arguments are reused via partial application.',
        });
      }),
    )(nodes);

const isExemptMultiArgCallee = (ctx: RuleContext) => (call: ts.CallExpression): boolean => {
  if (ctx.inspector.isFlowCall(call)) {
    return true;
  }
  if (ts.isPropertyAccessExpression(call.expression)) {
    const prop = call.expression.name.text;
    if (prop === 'with' || prop === 'when') {
      return true;
    }
  }
  const symOpt = O.fromNullable(ctx.checker.getSymbolAtLocation(call.expression));
  return O.exists((sym: ts.Symbol) =>
    O.exists(
      (d: ts.Declaration) =>
        d.getSourceFile().fileName.includes('node_modules') ||
        d.getSourceFile().isDeclarationFile,
    )(O.fromNullable(sym.declarations?.[0])),
  )(symOpt);
};

const checkCallArity =
  (ctx: RuleContext) =>
  (nodes: ReadonlyArray<ts.Node>): ReadonlyArray<DiagnosticError> =>
    flow(
      RA.filter(
        (n: ts.Node): n is ts.CallExpression =>
          ts.isCallExpression(n) &&
          n.arguments.length > 1 &&
          !isExemptMultiArgCallee(ctx)(n),
      ),
      RA.map((n: ts.CallExpression) =>
        makePfError(ctx)({
          ruleId: 'unary-arity-only',
          node: n,
          message: `Multi-argument call (${n.arguments.length} args) violates unary-arity rule.`,
          fixGuidance:
            'Refactor the target function to take a single named Input/Domain Record (`f({ ... })`), or at most a 2-level curry (`f(config)(input)`) if partially applied.',
        }),
      ),
    )(nodes);

const referencesIdentifier = ({
  sf,
  name,
  node,
}: {
  readonly sf: ts.SourceFile;
  readonly name: string;
  readonly node: ts.Node;
}): boolean =>
  RA.some((n: ts.Node) => ts.isIdentifier(n) && n.text === name)(collectAllNodes(sf)(node));

const isNamespaceReceiver = (checker: ts.TypeChecker) => (expr: ts.Expression): boolean => {
  const sym = checker.getSymbolAtLocation(expr);
  if (sym === undefined) {
    return false;
  }
  const resolved =
    (sym.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(sym) : sym;
  return (
    (resolved.flags & (ts.SymbolFlags.ValueModule | ts.SymbolFlags.NamespaceModule)) !== 0
  );
};

const isMethodBindingWrapper = (checker: ts.TypeChecker) => (callee: ts.Expression): boolean =>
  ts.isPropertyAccessExpression(callee) && !isNamespaceReceiver(checker)(callee.expression);

const isEtaReducibleArrow = (ctx: RuleContext) => (arrow: ts.ArrowFunction): boolean => {
  if (arrow.parameters.length !== 1) {
    return false;
  }
  const param = arrow.parameters[0];
  if (param === undefined || !ts.isIdentifier(param.name)) {
    return false;
  }
  const paramName = param.name.text;
  const body = ts.isParenthesizedExpression(arrow.body) ? arrow.body.expression : arrow.body;
  if (!ts.isCallExpression(body) || body.arguments.length !== 1) {
    return false;
  }
  if (isMethodBindingWrapper(ctx.checker)(body.expression)) {
    return false;
  }
  const arg = body.arguments[0];
  return (
    arg !== undefined &&
    ts.isIdentifier(arg) &&
    arg.text === paramName &&
    !referencesIdentifier({ sf: ctx.sourceFile, name: paramName, node: body.expression })
  );
};

const checkEtaReducible =
  (ctx: RuleContext) =>
  (nodes: ReadonlyArray<ts.Node>): ReadonlyArray<DiagnosticError> =>
    flow(
      RA.filter(
        (n: ts.Node): n is ts.ArrowFunction =>
          ts.isArrowFunction(n) && isEtaReducibleArrow(ctx)(n),
      ),
      RA.map((n: ts.ArrowFunction) =>
        makePfError(ctx)({
          ruleId: 'no-eta-reducible',
          node: n,
          message: 'Eta-reducible wrapper `x => f(x)` violates point-free style.',
          fixGuidance: 'Use the function `f` directly without the lambda wrapper.',
        }),
      ),
    )(nodes);

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
