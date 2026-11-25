import { sequenceS } from 'fp-ts/lib/Apply.js';
import { flow } from 'fp-ts/lib/function.js';
import * as O from 'fp-ts/lib/Option.js';
import * as RA from 'fp-ts/lib/ReadonlyArray.js';
import { Lens } from 'monocle-ts';
import * as ts from 'typescript';
import type { DiagnosticError, RuleContext } from '../model/report.js';

export type RuleRunner = (ctx: RuleContext) => ReadonlyArray<DiagnosticError>;

const sourceFileLens = Lens.fromPath<RuleContext>()(['sourceFile']);
const getLocationLens = Lens.fromPath<RuleContext>()(['inspector', 'getLocation']);
const getSnippetLens = Lens.fromPath<RuleContext>()(['inspector', 'getSnippet']);
const isPipeCallLens = Lens.fromPath<RuleContext>()(['inspector', 'isPipeCall']);
const isFlowCallLens = Lens.fromPath<RuleContext>()(['inspector', 'isFlowCall']);

const toNextQueue =
  (sf: ts.SourceFile) =>
  ({ head, tail }: { readonly head: ts.Node; readonly tail: ReadonlyArray<ts.Node> }) =>
    [head, [...head.getChildren(sf), ...tail]] as const;

const stepQueue = (sf: ts.SourceFile) => (queue: ReadonlyArray<ts.Node>) =>
  O.map(toNextQueue(sf))(sequenceS(O.Apply)({ head: RA.head(queue), tail: RA.tail(queue) }));

const collectAllNodes = (sf: ts.SourceFile) => (root: ts.Node) =>
  RA.unfold(RA.of(root), stepQueue(sf));

type CompErrorInput = {
  readonly ruleId: string;
  readonly node: ts.Node;
  readonly message: string;
  readonly fixGuidance: string;
};

const makeCompError =
  (ctx: RuleContext) =>
  ({ ruleId, node, message, fixGuidance }: CompErrorInput): DiagnosticError => ({
    ruleId,
    category: 'point-free',
    location: getLocationLens.get(ctx)(sourceFileLens.get(ctx))(node),
    message,
    snippet: getSnippetLens.get(ctx)(sourceFileLens.get(ctx))(node),
    fixGuidance,
  });

const toPipeError = (ctx: RuleContext) => (n: ts.Node) =>
  makeCompError(ctx)({
    ruleId: 'no-pipe',
    node: n,
    message: '`pipe(...)` is forbidden; use point-free `flow(...)` composition instead.',
    fixGuidance:
      'Replace `pipe(x, f, g)` with a named `flow(f, g)` binding and pass `x` at the call boundary.',
  });

const checkNoPipe = (ctx: RuleContext) =>
  flow(RA.filter(isPipeCallLens.get(ctx)), RA.map(toPipeError(ctx)));

const dupNode = (n: ts.Node) => [n, n] as const;

const stepParent = (node: ts.Node) => O.map(dupNode)(O.fromNullable(node.parent));

const getAncestors = (node: ts.Node) => RA.unfold(node, stepParent);

const hasNestedFlowAncestor = (ctx: RuleContext) =>
  flow(getAncestors, RA.some(isFlowCallLens.get(ctx)));

const isNestedFlowNode = (ctx: RuleContext) => (n: ts.Node) =>
  isFlowCallLens.get(ctx)(n) && hasNestedFlowAncestor(ctx)(n);

const toNestedFlowError = (ctx: RuleContext) => (n: ts.Node) =>
  makeCompError(ctx)({
    ruleId: 'no-nested-flow',
    node: n,
    message: 'Nesting `flow(...)` inside another `flow(...)` is forbidden.',
    fixGuidance:
      'Hoist the inner `flow(...)` to a named private `const` binding and reference it by name.',
  });

const checkNoNestedFlow = (ctx: RuleContext) =>
  flow(RA.filter(isNestedFlowNode(ctx)), RA.map(toNestedFlowError(ctx)));

const isTrivialFlowCall =
  (ctx: RuleContext) =>
  (n: ts.Node): n is ts.CallExpression =>
    ts.isCallExpression(n) && isFlowCallLens.get(ctx)(n) && n.arguments.length < 2;

const toTrivialFlowError = (ctx: RuleContext) => (n: ts.CallExpression) =>
  makeCompError(ctx)({
    ruleId: 'no-trivial-flow',
    node: n,
    message: `Trivial \`flow\` with ${n.arguments.length} step(s) is forbidden; \`flow\` must compose at least 2 functions.`,
    fixGuidance: 'Use the underlying function directly or compose at least 2 steps.',
  });

const checkNoTrivialFlow = (ctx: RuleContext) =>
  flow(RA.filter(isTrivialFlowCall(ctx)), RA.map(toTrivialFlowError(ctx)));

const applyNodeCheck =
  (nodes: ReadonlyArray<ts.Node>) =>
  (check: (ns: ReadonlyArray<ts.Node>) => ReadonlyArray<DiagnosticError>) =>
    check(nodes);

const runChecksOnNodes = (ctx: RuleContext) => (nodes: ReadonlyArray<ts.Node>) =>
  RA.chain(applyNodeCheck(nodes))([
    checkNoPipe(ctx),
    checkNoNestedFlow(ctx),
    checkNoTrivialFlow(ctx),
  ]);

const runCompositionChecks = (ctx: RuleContext) =>
  runChecksOnNodes(ctx)(collectAllNodes(sourceFileLens.get(ctx))(sourceFileLens.get(ctx)));

const identityCtx = (ctx: RuleContext) => ctx;

export const checkCompositionRules = flow(
  identityCtx,
  runCompositionChecks,
) satisfies RuleRunner;
