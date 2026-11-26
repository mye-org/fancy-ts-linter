import { flow } from 'fp-ts/lib/function.js';
import * as O from 'fp-ts/lib/Option.js';

import { fromNullable as liftNullable } from 'fp-ts/lib/Option.js';
import * as RA from 'fp-ts/lib/ReadonlyArray.js';
import * as ts from 'typescript';
import { iso } from 'newtype-ts';
import type { DiagnosticError, RuleContext, DiagnosticMessage, FixGuidance, RuleId } from '../model/report.js';

const isoRuleId = iso<RuleId>();
const isoDiagMsg = iso<DiagnosticMessage>();
const isoFixGuidance = iso<FixGuidance>();

export type RuleRunner = (ctx: RuleContext) => ReadonlyArray<DiagnosticError>;

const expandHeadNode =
  ({ sf, queue }: { readonly sf: ts.SourceFile; readonly queue: ReadonlyArray<ts.Node> }) =>
  (head: ts.Node): readonly [ts.Node, ReadonlyArray<ts.Node>] => [
    head,
    [...head.getChildren(sf), ...RA.dropLeft(1)(queue)],
  ];

const stepNodeQueue = (sf: ts.SourceFile) => (queue: ReadonlyArray<ts.Node>) =>
  O.map(expandHeadNode({ sf, queue }))(RA.head(queue));

const collectAllNodes = (sf: ts.SourceFile) =>
  RA.unfold(RA.of<ts.Node>(sf), stepNodeQueue(sf));

type BranchErrorInput = {
  readonly ruleId: string;
  readonly node: ts.Node;
  readonly message: string;
  readonly fixGuidance: string;
};

const makeBranchError =
  (ctx: RuleContext) =>
  ({ ruleId, node, message, fixGuidance }: BranchErrorInput): DiagnosticError => ({    ruleId: isoRuleId.wrap(ruleId),
    category: 'branching',
    location: ctx.inspector.getLocation(ctx.sourceFile)(node),
    message: isoDiagMsg.wrap(message),
    snippet: ctx.inspector.getSnippet(ctx.sourceFile)(node),
    fixGuidance: isoFixGuidance.wrap(fixGuidance),
  });

const toNoTernaryError = (ctx: RuleContext) => (n: ts.ConditionalExpression) =>
  makeBranchError(ctx)({
    ruleId: 'no-ternary',
    node: n,
    message: 'Ternary operator `? :` is forbidden.',
    fixGuidance:
      'Use `fp-ts` (`B.match`, `O.fromPredicate`, `E.fromPredicate`), exhaustive record dispatch, or `ts-pattern`.',
  });

const checkNoTernary = (ctx: RuleContext) =>
  flow(RA.filter(ts.isConditionalExpression), RA.map(toNoTernaryError(ctx)));

const isOptionalChainNode = (n: ts.Node) =>
  (ts.isPropertyAccessExpression(n) && n.questionDotToken !== undefined) ||
  (ts.isElementAccessExpression(n) && n.questionDotToken !== undefined) ||
  (ts.isCallExpression(n) && n.questionDotToken !== undefined);

const isNullishCoalescingNode = (n: ts.Node) =>
  ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken;

const isNullishOperatorNode = (n: ts.Node) =>
  isOptionalChainNode(n) || isNullishCoalescingNode(n);

const toNoNullishError = (ctx: RuleContext) => (n: ts.Node) =>
  makeBranchError(ctx)({
    ruleId: 'no-nullish-operators',
    node: n,
    message: 'Optional chaining `?.` and nullish coalescing `??` are forbidden.',
    fixGuidance:
      'Lift nullable values into `fp-ts/Option` via `O.fromNullable` and compose with `O.map` / `O.getOrElse`.',
  });

const checkNoNullishOperators = (ctx: RuleContext) =>
  flow(RA.filter(isNullishOperatorNode), RA.map(toNoNullishError(ctx)));

const isTsPatternDecl = (d: ts.Declaration) =>
  d.getSourceFile().fileName.includes('ts-pattern');

const isTsPatternSymbol = (sym: ts.Symbol) =>
  sym.declarations !== undefined && RA.exists(isTsPatternDecl)(sym.declarations);

const isTsPatternMatchRoot = (ctx: RuleContext) => (n: ts.Node) =>
  ts.isCallExpression(n) &&
  ts.isIdentifier(n.expression) &&
  n.expression.text === 'match' &&
  O.exists(isTsPatternSymbol)(liftNullable(ctx.checker.getSymbolAtLocation(n.expression)));

const isPropAccessOfNode =
  (node: ts.Node) =>
  (parent: ts.Node): parent is ts.PropertyAccessExpression =>
    ts.isPropertyAccessExpression(parent) && parent.expression === node;

const toMethodCallPair =
  (prop: ts.PropertyAccessExpression) =>
  (call: ts.CallExpression): readonly [string, ts.CallExpression] => [prop.name.text, call];

const extractParentCall = (prop: ts.PropertyAccessExpression) =>
  O.map(toMethodCallPair(prop))(O.filter(ts.isCallExpression)(liftNullable(prop.parent)));

const stepChainedCall = (node: ts.Node) =>
  O.chain(extractParentCall)(O.filter(isPropAccessOfNode(node))(liftNullable(node.parent)));

const isTerminalMethod = (name: string) =>
  name === 'exhaustive' || name === 'run' || name === 'otherwise';

const isExhaustiveMethod = (name: string) => name === 'exhaustive';

const collectChainedMethods = (node: ts.Node) => RA.unfold(node, stepChainedCall);

const endsInExhaustive = flow(
  collectChainedMethods,
  RA.findFirst(isTerminalMethod),
  O.exists(isExhaustiveMethod),
);

const isNonExhaustiveTsPatternMatch =
  (ctx: RuleContext) =>
  (n: ts.Node): n is ts.CallExpression =>
    isTsPatternMatchRoot(ctx)(n) && !endsInExhaustive(n);

const toTsPatternExhaustiveError = (ctx: RuleContext) => (n: ts.CallExpression) =>
  makeBranchError(ctx)({
    ruleId: 'ts-pattern-exhaustive',
    node: n,
    message: '`ts-pattern` `match(...)` chain must terminate with `.exhaustive()`.',
    fixGuidance:
      'Replace `.otherwise(...)` / `.run()` with explicit `.with(...)` cases and `.exhaustive()`.',
  });

const checkTsPatternExhaustive = (ctx: RuleContext) =>
  flow(RA.filter(isNonExhaustiveTsPatternMatch(ctx)), RA.map(toTsPatternExhaustiveError(ctx)));

export const checkBranchingRules = ((ctx: RuleContext): ReadonlyArray<DiagnosticError> => {
  const nodes = collectAllNodes(ctx.sourceFile);
  return [
    ...checkNoTernary(ctx)(nodes),
    ...checkNoNullishOperators(ctx)(nodes),
    ...checkTsPatternExhaustive(ctx)(nodes),
  ];
}) satisfies RuleRunner;
