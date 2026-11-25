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

const checkInlineLambdas =
  (ctx: RuleContext) =>
  (nodes: ReadonlyArray<ts.Node>): ReadonlyArray<DiagnosticError> =>
    flow(
      RA.filter(
        (n: ts.Node): n is ts.ArrowFunction | ts.FunctionExpression =>
          (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) &&
          !isTopLevelCurriedArrow(n),
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
          n.parameters.length !== 1,
      ),
      RA.map((n: ts.ArrowFunction | ts.FunctionExpression) =>
        makePfError(ctx)({
          ruleId: 'unary-arity-only',
          node: n,
          message: `Function must have arity 1 (single parameter), found ${n.parameters.length} parameter(s).`,
          fixGuidance:
            n.parameters.length === 0
              ? 'Replace 0-arg thunk with `constant(...)` or accept a single domain input parameter.'
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

const isEtaReducibleArrow = (sf: ts.SourceFile) => (arrow: ts.ArrowFunction): boolean => {
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
  const arg = body.arguments[0];
  return (
    arg !== undefined &&
    ts.isIdentifier(arg) &&
    arg.text === paramName &&
    !referencesIdentifier({ sf, name: paramName, node: body.expression })
  );
};

const checkEtaReducible =
  (ctx: RuleContext) =>
  (nodes: ReadonlyArray<ts.Node>): ReadonlyArray<DiagnosticError> =>
    flow(
      RA.filter(
        (n: ts.Node): n is ts.ArrowFunction =>
          ts.isArrowFunction(n) && isEtaReducibleArrow(ctx.sourceFile)(n),
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

const runPointFreeChecks = (ctx: RuleContext): ReadonlyArray<DiagnosticError> => {
  const nodes = collectAllNodes(ctx.sourceFile)(ctx.sourceFile);
  return [
    ...checkInlineLambdas(ctx)(nodes),
    ...checkArrowArity(ctx)(nodes),
    ...checkCurryDepth(ctx)(nodes),
    ...checkCallArity(ctx)(nodes),
    ...checkEtaReducible(ctx)(nodes),
  ];
};

const identityCtx = (ctx: RuleContext) => ctx;

export const checkPointFreeRules = flow(
  identityCtx,
  runPointFreeChecks,
) satisfies RuleRunner;
