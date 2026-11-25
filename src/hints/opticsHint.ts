import { flow } from 'fp-ts/lib/function.js';
import * as O from 'fp-ts/lib/Option.js';
import * as RA from 'fp-ts/lib/ReadonlyArray.js';
import { Lens } from 'monocle-ts';
import * as ts from 'typescript';
import type { AgentHint, RuleContext } from '../model/report.js';

export type HintRunner = (ctx: RuleContext) => ReadonlyArray<AgentHint>;

type ChainMatch = {
  readonly node: ts.PropertyAccessExpression;
  readonly chainText: string;
};

type QueueStep = {
  readonly sf: ts.SourceFile;
  readonly queue: ReadonlyArray<ts.Node>;
};

type RepeatedPathsInput = {
  readonly ctx: RuleContext;
  readonly cs: ReadonlyArray<ChainMatch>;
};

const propAccessNameLens = Lens.fromPath<ts.PropertyAccessExpression>()(['name', 'text']);

const expandQueue =
  ({ sf, queue }: QueueStep) =>
  (head: ts.Node): readonly [ts.Node, ReadonlyArray<ts.Node>] => [
    head,
    [...head.getChildren(sf), ...queue.slice(1)],
  ];

const stepNodeQueue =
  (sf: ts.SourceFile) =>
  (queue: ReadonlyArray<ts.Node>) =>
    O.map(expandQueue({ sf, queue }))(RA.head(queue));

const collectAllNodes =
  (sf: ts.SourceFile) =>
  (root: ts.Node) =>
    RA.unfold([root], stepNodeQueue(sf));

const formatPropChain =
  (parentName: string) =>
  (expr: ts.PropertyAccessExpression) =>
    `${propAccessNameLens.get(expr)}.${parentName}`;

const getNestedChainText = (n: ts.PropertyAccessExpression) =>
  flow(
    O.fromPredicate(ts.isPropertyAccessExpression),
    O.map(formatPropChain(propAccessNameLens.get(n))),
  )(n.expression);

const toChainMatch =
  (node: ts.PropertyAccessExpression) =>
  (chainText: string): ChainMatch => ({ node, chainText });

const matchPropertyChain = (pa: ts.PropertyAccessExpression) =>
  O.map(toChainMatch(pa))(getNestedChainText(pa));

const extractChainMatch = flow(
  O.fromPredicate(ts.isPropertyAccessExpression),
  O.chain(matchPropertyChain),
);

const isNonLibChain = (c: ChainMatch) =>
  !/^(O|E|TE|T|RA|RR|B|P|Lens|Prism|Optional|Traversal)\./.test(c.chainText);

const hasAtLeast3Chains = (cs: ReadonlyArray<ChainMatch>) => cs.length >= 3;

const makeRepeatedPathsHint =
  ({ ctx, cs }: RepeatedPathsInput) =>
  (first: ChainMatch): AgentHint => ({
    hintId: 'optic-repeated-nested-paths',
    category: 'optic',
    priority: 'medium',
    location: ctx.inspector.getLocation(ctx.sourceFile)(first.node),
    evidence: `Detected ${cs.length} nested property accesses (e.g., \`${first.chainText}\`).`,
    suggestion:
      'Extract reusable `monocle-ts` Optics (`Lens.fromPath<Entity>()([...])`) for point-free nested reads and updates.',
    suggestedSignature: O.none,
    researchQuestions: [
      'Which nested fields are read or updated across multiple pipeline steps?',
    ],
  });

const toRepeatedPathsHint =
  (ctx: RuleContext) =>
  (cs: ReadonlyArray<ChainMatch>) =>
    O.map(makeRepeatedPathsHint({ ctx, cs }))(RA.head(cs));

const checkRepeatedNestedPaths = (ctx: RuleContext) =>
  flow(
    RA.filterMap(extractChainMatch),
    RA.filter(isNonLibChain),
    O.fromPredicate(hasAtLeast3Chains),
    O.chain(toRepeatedPathsHint(ctx)),
    O.match(RA.zero<AgentHint>, RA.of),
  );

const isSpreadWithArrayMap =
  (sf: ts.SourceFile) =>
  (n: ts.Node) =>
    ts.isObjectLiteralExpression(n) &&
    RA.some(ts.isSpreadAssignment)(n.properties) &&
    /\.(map)\(|RA\.map\(/.test(n.getText(sf));

const makeTraversalHint =
  (ctx: RuleContext) =>
  (first: ts.Node): AgentHint => ({
    hintId: 'optic-traversal-candidate',
    category: 'optic',
    priority: 'medium',
    location: ctx.inspector.getLocation(ctx.sourceFile)(first),
    evidence: 'Object spread combines shallow copy with nested array mapping.',
    suggestion:
      'Use a `monocle-ts` `Traversal` (`Lens.fromProp` composed with `fromTraversable(RA.Traversable)`) for declarative nested collection updates.',
    suggestedSignature: O.none,
    researchQuestions: ['Can this nested array update be composed as a reusable `Traversal`?'],
  });

const checkNestedArrayUpdates = (ctx: RuleContext) =>
  flow(
    RA.filter(isSpreadWithArrayMap(ctx.sourceFile)),
    RA.head,
    O.map(makeTraversalHint(ctx)),
    O.match(RA.zero<AgentHint>, RA.of),
  );

const runWithNodes =
  (ctx: RuleContext) =>
  (nodes: ReadonlyArray<ts.Node>) => [
    ...checkRepeatedNestedPaths(ctx)(nodes),
    ...checkNestedArrayUpdates(ctx)(nodes),
  ];

const runOpticsHints = (ctx: RuleContext) =>
  runWithNodes(ctx)(collectAllNodes(ctx.sourceFile)(ctx.sourceFile));

const identityCtx = (ctx: RuleContext) => ctx;

export const detectOpticsHints = flow(
  identityCtx,
  runOpticsHints,
) satisfies HintRunner;


