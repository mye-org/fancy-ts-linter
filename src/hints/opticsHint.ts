import { flow } from 'fp-ts/lib/function.js';
import * as O from 'fp-ts/lib/Option.js';
import * as RA from 'fp-ts/lib/ReadonlyArray.js';
import * as ts from 'typescript';
import type { AgentHint, RuleContext } from '../model/report.js';

export type HintRunner = (ctx: RuleContext) => ReadonlyArray<AgentHint>;

const collectAllNodes = (sf: ts.SourceFile) => (node: ts.Node): ReadonlyArray<ts.Node> => [
  node,
  ...RA.chain(collectAllNodes(sf))(node.getChildren(sf)),
];

const getNestedChainText = (sf: ts.SourceFile) => (n: ts.PropertyAccessExpression): O.Option<string> =>
  ts.isPropertyAccessExpression(n.expression)
    ? O.some(`${n.expression.name.text}.${n.name.text}`)
    : O.none;

const checkRepeatedNestedPaths = (ctx: RuleContext) => (nodes: ReadonlyArray<ts.Node>): ReadonlyArray<AgentHint> => {
  const chains = RA.filterMap((n: ts.Node) =>
    ts.isPropertyAccessExpression(n)
      ? O.map((chainText: string) => ({ node: n, chainText }))(
          getNestedChainText(ctx.sourceFile)(n),
        )
      : O.none,
  )(nodes);

  const nonLibChains = RA.filter(
    (c: { readonly chainText: string }) =>
      !/^(O|E|TE|T|RA|RR|B|P|Lens|Prism|Optional|Traversal)\./.test(c.chainText),
  )(chains);

  return nonLibChains.length >= 3
    ? [
        {
          hintId: 'optic-repeated-nested-paths',
          category: 'optic',
          priority: 'medium',
          location: ctx.inspector.getLocation(ctx.sourceFile)(nonLibChains[0]!.node),
          evidence: `Detected ${nonLibChains.length} nested property accesses (e.g., \`${nonLibChains[0]!.chainText}\`).`,
          suggestion:
            'Extract reusable `monocle-ts` Optics (`Lens.fromPath<Entity>()([...])`) for point-free nested reads and updates.',
          suggestedSignature: O.none,
          researchQuestions: [
            'Which nested fields are read or updated across multiple pipeline steps?',
          ],
        },
      ]
    : [];
};

const checkNestedArrayUpdates = (ctx: RuleContext) => (nodes: ReadonlyArray<ts.Node>): ReadonlyArray<AgentHint> => {
  const spreadWithArrayMap = RA.filter((n: ts.Node): n is ts.ObjectLiteralExpression => {
    if (!ts.isObjectLiteralExpression(n) || !RA.some(ts.isSpreadAssignment)(n.properties)) {
      return false;
    }
    return /\.(map)\(|RA\.map\(/.test(n.getText(ctx.sourceFile));
  })(nodes);

  return RA.isNonEmpty(spreadWithArrayMap)
    ? [
        {
          hintId: 'optic-traversal-candidate',
          category: 'optic',
          priority: 'medium',
          location: ctx.inspector.getLocation(ctx.sourceFile)(spreadWithArrayMap[0]!),
          evidence: 'Object spread combines shallow copy with nested array mapping.',
          suggestion:
            'Use a `monocle-ts` `Traversal` (`Lens.fromProp` composed with `fromTraversable(RA.Traversable)`) for declarative nested collection updates.',
          suggestedSignature: O.none,
          researchQuestions: ['Can this nested array update be composed as a reusable `Traversal`?'],
        },
      ]
    : [];
};

const runOpticsHints = (ctx: RuleContext): ReadonlyArray<AgentHint> => {
  const nodes = collectAllNodes(ctx.sourceFile)(ctx.sourceFile);
  return [...checkRepeatedNestedPaths(ctx)(nodes), ...checkNestedArrayUpdates(ctx)(nodes)];
};

const identityCtx = (ctx: RuleContext) => ctx;

export const detectOpticsHints = flow(
  identityCtx,
  runOpticsHints,
) satisfies HintRunner;
