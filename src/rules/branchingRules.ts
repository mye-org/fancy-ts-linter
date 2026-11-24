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

const makeBranchError =
  (ctx: RuleContext) =>
  (ruleId: string) =>
  (node: ts.Node) =>
  (message: string) =>
  (fixGuidance: string): DiagnosticError => ({
    ruleId,
    category: 'branching',
    location: ctx.inspector.getLocation(ctx.sourceFile)(node),
    message,
    snippet: ctx.inspector.getSnippet(ctx.sourceFile)(node),
    fixGuidance,
  });

const checkNoTernary =
  (ctx: RuleContext) =>
  (nodes: ReadonlyArray<ts.Node>): ReadonlyArray<DiagnosticError> =>
    flow(
      RA.filter(ts.isConditionalExpression),
      RA.map((n: ts.ConditionalExpression) =>
        makeBranchError(ctx)('no-ternary')(n)(
          'Ternary operator `? :` is forbidden.',
        )(
          'Use `fp-ts` (`B.match`, `O.fromPredicate`, `E.fromPredicate`), exhaustive record dispatch, or `ts-pattern`.',
        ),
      ),
    )(nodes);

const isOptionalChainNode = (n: ts.Node): boolean =>
  (ts.isPropertyAccessExpression(n) && n.questionDotToken !== undefined) ||
  (ts.isElementAccessExpression(n) && n.questionDotToken !== undefined) ||
  (ts.isCallExpression(n) && n.questionDotToken !== undefined);

const isNullishCoalescingNode = (n: ts.Node): boolean =>
  ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken;

const checkNoNullishOperators =
  (ctx: RuleContext) =>
  (nodes: ReadonlyArray<ts.Node>): ReadonlyArray<DiagnosticError> =>
    flow(
      RA.filter((n: ts.Node) => isOptionalChainNode(n) || isNullishCoalescingNode(n)),
      RA.map((n: ts.Node) =>
        makeBranchError(ctx)('no-nullish-operators')(n)(
          'Optional chaining `?.` and nullish coalescing `??` are forbidden.',
        )('Lift nullable values into `fp-ts/Option` via `O.fromNullable` and compose with `O.map` / `O.getOrElse`.'),
      ),
    )(nodes);

const isTsPatternMatchRoot = (ctx: RuleContext) => (n: ts.Node): n is ts.CallExpression => {
  if (!ts.isCallExpression(n) || !ts.isIdentifier(n.expression) || n.expression.text !== 'match') {
    return false;
  }
  const symOpt = O.fromNullable(ctx.checker.getSymbolAtLocation(n.expression));
  return O.exists((sym: ts.Symbol) =>
    O.exists((d: ts.Declaration) => d.getSourceFile().fileName.includes('ts-pattern'))(
      O.fromNullable(sym.declarations?.[0]),
    ),
  )(symOpt);
};

const endsInExhaustive = (node: ts.Node): boolean => {
  const parent = node.parent;
  if (parent === undefined) {
    return false;
  }
  if (
    ts.isPropertyAccessExpression(parent) &&
    parent.expression === node &&
    parent.parent !== undefined &&
    ts.isCallExpression(parent.parent)
  ) {
    if (parent.name.text === 'exhaustive') {
      return true;
    }
    if (parent.name.text === 'run' || parent.name.text === 'otherwise') {
      return false;
    }
    return endsInExhaustive(parent.parent);
  }
  return false;
};

const checkTsPatternExhaustive =
  (ctx: RuleContext) =>
  (nodes: ReadonlyArray<ts.Node>): ReadonlyArray<DiagnosticError> =>
    flow(
      RA.filter(
        (n: ts.Node): n is ts.CallExpression =>
          isTsPatternMatchRoot(ctx)(n) && !endsInExhaustive(n),
      ),
      RA.map((n: ts.CallExpression) =>
        makeBranchError(ctx)('ts-pattern-exhaustive')(n)(
          '`ts-pattern` `match(...)` chain must terminate with `.exhaustive()`.',
        )('Replace `.otherwise(...)` / `.run()` with explicit `.with(...)` cases and `.exhaustive()`.'),
      ),
    )(nodes);

const runBranchingChecks = (ctx: RuleContext): ReadonlyArray<DiagnosticError> => {
  const nodes = collectAllNodes(ctx.sourceFile)(ctx.sourceFile);
  return [
    ...checkNoTernary(ctx)(nodes),
    ...checkNoNullishOperators(ctx)(nodes),
    ...checkTsPatternExhaustive(ctx)(nodes),
  ];
};

const identityCtx = (ctx: RuleContext) => ctx;

export const checkBranchingRules = flow(
  identityCtx,
  runBranchingChecks,
) satisfies RuleRunner;
