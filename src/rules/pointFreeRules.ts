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

const makePfError =
  (ctx: RuleContext) =>
  (ruleId: string) =>
  (node: ts.Node) =>
  (message: string) =>
  (fixGuidance: string): DiagnosticError => ({
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
        makePfError(ctx)('no-inline-lambda')(n)(
          'Inline anonymous lambda is forbidden; extract to a named private unary function or use an Optic.',
        )(
          'Extract this lambda into a named top-level `const fn = ...` or replace property access with a `monocle-ts` Optic.',
        ),
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
        makePfError(ctx)('unary-arity-only')(n)(
          `Function must have arity 1 (single parameter), found ${n.parameters.length} parameter(s).`,
        )(
          n.parameters.length === 0
            ? 'Replace 0-arg thunk with `constant(...)` or accept a single domain input parameter.'
            : 'Curry data-last (`a => b => ...`) for config/predicates, or bundle peer fields into a single Domain Record type.',
        ),
      ),
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
        makePfError(ctx)('unary-arity-only')(n)(
          `Multi-argument call (${n.arguments.length} args) violates unary-arity rule.`,
        )('Refactor the target function to be curried (`f(a)(b)`) or take a single Domain Record.'),
      ),
    )(nodes);

const referencesIdentifier = (sf: ts.SourceFile) => (name: string) => (node: ts.Node): boolean =>
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
    !referencesIdentifier(sf)(paramName)(body.expression)
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
        makePfError(ctx)('no-eta-reducible')(n)(
          'Eta-reducible wrapper `x => f(x)` violates point-free style.',
        )('Use the function `f` directly without the lambda wrapper.'),
      ),
    )(nodes);

const runPointFreeChecks = (ctx: RuleContext): ReadonlyArray<DiagnosticError> => {
  const nodes = collectAllNodes(ctx.sourceFile)(ctx.sourceFile);
  return [
    ...checkInlineLambdas(ctx)(nodes),
    ...checkArrowArity(ctx)(nodes),
    ...checkCallArity(ctx)(nodes),
    ...checkEtaReducible(ctx)(nodes),
  ];
};

const identityCtx = (ctx: RuleContext) => ctx;

export const checkPointFreeRules = flow(
  identityCtx,
  runPointFreeChecks,
) satisfies RuleRunner;
