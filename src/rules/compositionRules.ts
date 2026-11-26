import { flow } from 'fp-ts/lib/function.js';
import * as O from 'fp-ts/lib/Option.js';
import * as RA from 'fp-ts/lib/ReadonlyArray.js';
import { Lens } from 'monocle-ts';
import * as ts from 'typescript';
import type { DiagnosticError, RuleContext } from '../model/report.js';

export type RuleRunner = (ctx: RuleContext) => ReadonlyArray<DiagnosticError>;

const isFlowCallLens = Lens.fromPath<RuleContext>()(['inspector', 'isFlowCall']);

const argsLengthLens = Lens.fromPath<ts.CallExpression>()(['arguments', 'length']);

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
    location: ctx.inspector.getLocation(ctx.sourceFile)(node),
    message,
    snippet: ctx.inspector.getSnippet(ctx.sourceFile)(node),
    fixGuidance,
  });

const isPipeCallFromCtx = (ctx: RuleContext) => (n: ts.Node) => ctx.inspector.isPipeCall(n);

const toNoPipeError = (ctx: RuleContext) => (n: ts.Node) =>
  makeCompError(ctx)({
    ruleId: 'no-pipe',
    node: n,
    message: '`pipe(...)` is forbidden; use point-free `flow(...)` composition instead.',
    fixGuidance:
      'Replace `pipe(x, f, g)` with a named `flow(f, g)` binding and pass `x` at the call boundary.',
  });

const checkNoPipe = (ctx: RuleContext) =>
  flow(RA.filter(isPipeCallFromCtx(ctx)), RA.map(toNoPipeError(ctx)));

const dupParent = (parent: ts.Node) => [parent, parent] as const;

const stepParentNode = (node: ts.Node) => O.map(dupParent)(O.fromNullable(node.parent));

const getAncestors = (node: ts.Node) => RA.unfold(node, stepParentNode);

const hasNestedFlowAncestor = (ctx: RuleContext) =>
  flow(getAncestors, RA.some(isFlowCallLens.get(ctx)));

const isNestedFlowNode = (ctx: RuleContext) => (n: ts.Node) =>
  isFlowCallLens.get(ctx)(n) && hasNestedFlowAncestor(ctx)(n);

const toNoNestedFlowError = (ctx: RuleContext) => (n: ts.Node) =>
  makeCompError(ctx)({
    ruleId: 'no-nested-flow',
    node: n,
    message: 'Nesting `flow(...)` inside another `flow(...)` is forbidden.',
    fixGuidance:
      'Hoist the inner `flow(...)` to a named private `const` binding and reference it by name.',
  });

const checkNoNestedFlow = (ctx: RuleContext) =>
  flow(RA.filter(isNestedFlowNode(ctx)), RA.map(toNoNestedFlowError(ctx)));

const isTrivialFlowNode =
  (ctx: RuleContext) =>
  (n: ts.Node): n is ts.CallExpression =>
    ts.isCallExpression(n) && isFlowCallLens.get(ctx)(n) && argsLengthLens.get(n) < 2;

const toNoTrivialFlowError = (ctx: RuleContext) => (n: ts.CallExpression) =>
  makeCompError(ctx)({
    ruleId: 'no-trivial-flow',
    node: n,
    message: `Trivial \`flow\` with ${argsLengthLens.get(n)} step(s) is forbidden; \`flow\` must compose at least 2 functions.`,
    fixGuidance: 'Use the underlying function directly or compose at least 2 steps.',
  });

const checkNoTrivialFlow = (ctx: RuleContext) =>
  flow(RA.filter(isTrivialFlowNode(ctx)), RA.map(toNoTrivialFlowError(ctx)));

export const checkCompositionRules = ((ctx: RuleContext): ReadonlyArray<DiagnosticError> => {
  const nodes = collectAllNodes(ctx.sourceFile);
  return [
    ...checkNoPipe(ctx)(nodes),
    ...checkNoNestedFlow(ctx)(nodes),
    ...checkNoTrivialFlow(ctx)(nodes),
  ];
}) satisfies RuleRunner;
