import { sequenceS } from 'fp-ts/lib/Apply.js';
import { flow } from 'fp-ts/lib/function.js';
import * as O from 'fp-ts/lib/Option.js';
import * as RA from 'fp-ts/lib/ReadonlyArray.js';
import { Lens } from 'monocle-ts';
import * as ts from 'typescript';
import { SyntaxKind } from 'typescript';
import type { DiagnosticError, RuleContext } from '../model/report.js';

export type RuleRunner = (ctx: RuleContext) => ReadonlyArray<DiagnosticError>;

const sourceFileLens = Lens.fromPath<RuleContext>()(['sourceFile']);
const checkerLens = Lens.fromPath<RuleContext>()(['checker']);
const getLocationLens = Lens.fromPath<RuleContext>()(['inspector', 'getLocation']);
const getSnippetLens = Lens.fromPath<RuleContext>()(['inspector', 'getSnippet']);
const operatorKindLens = Lens.fromPath<ts.BinaryExpression>()(['operatorToken', 'kind']);
const propNameTextLens = Lens.fromPath<ts.PropertyAccessExpression>()(['name', 'text']);

const toNextQueue =
  (sf: ts.SourceFile) =>
  ({ head, tail }: { readonly head: ts.Node; readonly tail: ReadonlyArray<ts.Node> }) =>
    [head, [...head.getChildren(sf), ...tail]] as const;

const stepQueue = (sf: ts.SourceFile) => (queue: ReadonlyArray<ts.Node>) =>
  O.map(toNextQueue(sf))(sequenceS(O.Apply)({ head: RA.head(queue), tail: RA.tail(queue) }));

const collectAllNodes = (sf: ts.SourceFile) => (root: ts.Node) =>
  RA.unfold(RA.of(root), stepQueue(sf));

type BranchErrorInput = {
  readonly ruleId: string;
  readonly node: ts.Node;
  readonly message: string;
  readonly fixGuidance: string;
};

const makeBranchError =
  (ctx: RuleContext) =>
  ({ ruleId, node, message, fixGuidance }: BranchErrorInput): DiagnosticError => ({
    ruleId,
    category: 'branching',
    location: getLocationLens.get(ctx)(sourceFileLens.get(ctx))(node),
    message,
    snippet: getSnippetLens.get(ctx)(sourceFileLens.get(ctx))(node),
    fixGuidance,
  });

const toTernaryError = (ctx: RuleContext) => (n: ts.ConditionalExpression) =>
  makeBranchError(ctx)({
    ruleId: 'no-ternary',
    node: n,
    message: 'Ternary operator `? :` is forbidden.',
    fixGuidance:
      'Use `fp-ts` (`B.match`, `O.fromPredicate`, `E.fromPredicate`), exhaustive record dispatch, or `ts-pattern`.',
  });

const checkNoTernary = (ctx: RuleContext) =>
  flow(RA.filter(ts.isConditionalExpression), RA.map(toTernaryError(ctx)));

const isOptionalChainNode = (n: ts.Node) =>
  (ts.isPropertyAccessExpression(n) && n.questionDotToken !== undefined) ||
  (ts.isElementAccessExpression(n) && n.questionDotToken !== undefined) ||
  (ts.isCallExpression(n) && n.questionDotToken !== undefined);

const isNullishCoalescingNode = (n: ts.Node) =>
  ts.isBinaryExpression(n) && operatorKindLens.get(n) === SyntaxKind.QuestionQuestionToken;

const isNullishNode = (n: ts.Node) =>
  isOptionalChainNode(n) || isNullishCoalescingNode(n);

const toNullishError = (ctx: RuleContext) => (n: ts.Node) =>
  makeBranchError(ctx)({
    ruleId: 'no-nullish-operators',
    node: n,
    message: 'Optional chaining `?.` and nullish coalescing `??` are forbidden.',
    fixGuidance:
      'Lift nullable values into `fp-ts/Option` via `O.fromNullable` and compose with `O.map` / `O.getOrElse`.',
  });

const checkNoNullishOperators = (ctx: RuleContext) =>
  flow(RA.filter(isNullishNode), RA.map(toNullishError(ctx)));

const isTsPatternDecl = (d: ts.Declaration) =>
  d.getSourceFile().fileName.includes('ts-pattern');

const firstDeclaration = (sym: ts.Symbol) =>
  O.chain(RA.head)(O.fromNullable(sym.declarations));

const isTsPatternSymbol = flow(firstDeclaration, O.exists(isTsPatternDecl));

const isMatchCallExpr = (n: ts.Node): n is ts.CallExpression =>
  ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'match';

const hasTsPatternSymbol = (ctx: RuleContext) => (n: ts.CallExpression) =>
  O.exists(isTsPatternSymbol)(
    O.fromNullable(checkerLens.get(ctx).getSymbolAtLocation(n.expression)),
  );

const isTsPatternMatchRoot =
  (ctx: RuleContext) =>
  (n: ts.Node): n is ts.CallExpression =>
    isMatchCallExpr(n) && hasTsPatternSymbol(ctx)(n);

const isPropAccessOn =
  (curr: ts.Node) =>
  (p: ts.Node): p is ts.PropertyAccessExpression =>
    ts.isPropertyAccessExpression(p) && p.expression === curr;

const toMethodAndCall =
  (p: ts.PropertyAccessExpression) =>
  (c: ts.CallExpression): readonly [string, ts.Node] => [propNameTextLens.get(p), c];

const callParentOf = (p: ts.PropertyAccessExpression) =>
  O.map(toMethodAndCall(p))(
    O.chain(O.fromPredicate(ts.isCallExpression))(O.fromNullable(p.parent)),
  );

const nextMethodStep = (curr: ts.Node) =>
  O.chain(callParentOf)(
    O.chain(O.fromPredicate(isPropAccessOn(curr)))(O.fromNullable(curr.parent)),
  );

const getChainedMethods = (node: ts.Node) => RA.unfold(node, nextMethodStep);

const isTerminalMethod = (name: string) =>
  name === 'exhaustive' || name === 'run' || name === 'otherwise';

const isExhaustiveName = (name: string) => name === 'exhaustive';

const endsInExhaustive = flow(
  getChainedMethods,
  RA.findFirst(isTerminalMethod),
  O.exists(isExhaustiveName),
);

const isNonExhaustiveMatch =
  (ctx: RuleContext) =>
  (n: ts.Node): n is ts.CallExpression =>
    isTsPatternMatchRoot(ctx)(n) && !endsInExhaustive(n);

const toExhaustiveError = (ctx: RuleContext) => (n: ts.CallExpression) =>
  makeBranchError(ctx)({
    ruleId: 'ts-pattern-exhaustive',
    node: n,
    message: '`ts-pattern` `match(...)` chain must terminate with `.exhaustive()`.',
    fixGuidance:
      'Replace `.otherwise(...)` / `.run()` with explicit `.with(...)` cases and `.exhaustive()`.',
  });

const checkTsPatternExhaustive = (ctx: RuleContext) =>
  flow(RA.filter(isNonExhaustiveMatch(ctx)), RA.map(toExhaustiveError(ctx)));

const applyNodeCheck =
  (nodes: ReadonlyArray<ts.Node>) =>
  (check: (ns: ReadonlyArray<ts.Node>) => ReadonlyArray<DiagnosticError>) =>
    check(nodes);

const runChecksOnNodes = (ctx: RuleContext) => (nodes: ReadonlyArray<ts.Node>) =>
  RA.chain(applyNodeCheck(nodes))([
    checkNoTernary(ctx),
    checkNoNullishOperators(ctx),
    checkTsPatternExhaustive(ctx),
  ]);

const runBranchingChecks = (ctx: RuleContext) =>
  runChecksOnNodes(ctx)(collectAllNodes(sourceFileLens.get(ctx))(sourceFileLens.get(ctx)));

const identityCtx = (ctx: RuleContext) => ctx;

export const checkBranchingRules = flow(
  identityCtx,
  runBranchingChecks,
) satisfies RuleRunner;
