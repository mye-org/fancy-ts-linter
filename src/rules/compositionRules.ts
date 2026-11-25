import { flow } from 'fp-ts/lib/function.js';
import * as RA from 'fp-ts/lib/ReadonlyArray.js';
import * as ts from 'typescript';
import type { DiagnosticError, RuleContext } from '../model/report.js';

export type RuleRunner = (ctx: RuleContext) => ReadonlyArray<DiagnosticError>;

const collectAllNodes = (sf: ts.SourceFile) => (node: ts.Node): ReadonlyArray<ts.Node> => [
  node,
  ...RA.chain(collectAllNodes(sf))(node.getChildren(sf)),
];

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

const checkNoPipe = (ctx: RuleContext) => (nodes: ReadonlyArray<ts.Node>): ReadonlyArray<DiagnosticError> =>
  flow(
    RA.filter((n: ts.Node) => ctx.inspector.isPipeCall(n)),
    RA.map((n: ts.Node) =>
      makeCompError(ctx)({
        ruleId: 'no-pipe',
        node: n,
        message: '`pipe(...)` is forbidden; use point-free `flow(...)` composition instead.',
        fixGuidance:
          'Replace `pipe(x, f, g)` with a named `flow(f, g)` binding and pass `x` at the call boundary.',
      }),
    ),
  )(nodes);

const hasNestedFlowAncestor = (ctx: RuleContext) => (node: ts.Node): boolean =>
  node.parent !== undefined &&
  (ctx.inspector.isFlowCall(node.parent) || hasNestedFlowAncestor(ctx)(node.parent));

const checkNoNestedFlow =
  (ctx: RuleContext) =>
  (nodes: ReadonlyArray<ts.Node>): ReadonlyArray<DiagnosticError> =>
    flow(
      RA.filter((n: ts.Node) => ctx.inspector.isFlowCall(n) && hasNestedFlowAncestor(ctx)(n)),
      RA.map((n: ts.Node) =>
        makeCompError(ctx)({
          ruleId: 'no-nested-flow',
          node: n,
          message: 'Nesting `flow(...)` inside another `flow(...)` is forbidden.',
          fixGuidance:
            'Hoist the inner `flow(...)` to a named private `const` binding and reference it by name.',
        }),
      ),
    )(nodes);

const checkNoTrivialFlow =
  (ctx: RuleContext) =>
  (nodes: ReadonlyArray<ts.Node>): ReadonlyArray<DiagnosticError> =>
    flow(
      RA.filter(
        (n: ts.Node): n is ts.CallExpression =>
          ts.isCallExpression(n) && ctx.inspector.isFlowCall(n) && n.arguments.length < 2,
      ),
      RA.map((n: ts.CallExpression) =>
        makeCompError(ctx)({
          ruleId: 'no-trivial-flow',
          node: n,
          message: `Trivial \`flow\` with ${n.arguments.length} step(s) is forbidden; \`flow\` must compose at least 2 functions.`,
          fixGuidance: 'Use the underlying function directly or compose at least 2 steps.',
        }),
      ),
    )(nodes);

export const checkCompositionRules = ((ctx: RuleContext): ReadonlyArray<DiagnosticError> => {
  const nodes = collectAllNodes(ctx.sourceFile)(ctx.sourceFile);
  return [
    ...checkNoPipe(ctx)(nodes),
    ...checkNoNestedFlow(ctx)(nodes),
    ...checkNoTrivialFlow(ctx)(nodes),
  ];
}) satisfies RuleRunner;
