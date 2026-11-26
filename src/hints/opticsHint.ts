import * as B from 'fp-ts/lib/boolean.js';
import { flow } from 'fp-ts/lib/function.js';
import * as O from 'fp-ts/lib/Option.js';
import * as RA from 'fp-ts/lib/ReadonlyArray.js';
import * as S from 'fp-ts/lib/string.js';
import * as ts from 'typescript';
import type { AgentHint, BindingInfo, RuleContext } from '../model/report.js';

export type HintRunner = (ctx: RuleContext) => ReadonlyArray<AgentHint>;

type AccessorOccurrence = {
  readonly bindingName: string;
  readonly chainText: string;
  readonly node: ts.Node;
};

const prependChildren =
  (input: { readonly sf: ts.SourceFile; readonly rest: ReadonlyArray<ts.Node> }) =>
  (head: ts.Node): readonly [ts.Node, ReadonlyArray<ts.Node>] => [
    head,
    [...head.getChildren(input.sf), ...input.rest],
  ];

const stepNode = (sf: ts.SourceFile) => (stack: ReadonlyArray<ts.Node>) =>
  O.map(prependChildren({ sf, rest: stack.slice(1) }))(RA.head(stack));

const collectAllNodes = (sf: ts.SourceFile) => (root: ts.Node) => {
  const initial: ReadonlyArray<ts.Node> = [root];
  return RA.unfold(initial, stepNode(sf));
};

const getPropNameText = (n: ts.PropertyAccessExpression) => n.name.text;

const formatChainWithChild =
  (child: ts.PropertyAccessExpression) => (parent: ts.PropertyAccessExpression) =>
    `${getPropNameText(parent)}.${getPropNameText(child)}`;

const getNestedChainText = (n: ts.PropertyAccessExpression) =>
  O.map(formatChainWithChild(n))(O.fromPredicate(ts.isPropertyAccessExpression)(n.expression));

const isNonLibChain = (chainText: string) =>
  !/^(O|E|TE|T|RA|RR|B|P|Lens|Prism|Optional|Traversal)\./.test(chainText);

const toAccessorOccurrence =
  (input: { readonly bindingName: string; readonly node: ts.Node }) => (chainText: string) => ({
    bindingName: input.bindingName,
    chainText,
    node: input.node,
  });

const extractNodeOccurrence = (bindingName: string) => (n: ts.Node) =>
  flow(
    O.fromPredicate(ts.isPropertyAccessExpression),
    O.chain(getNestedChainText),
    O.filter(isNonLibChain),
    O.map(toAccessorOccurrence({ bindingName, node: n })),
  )(n);

const extractExprOccurrences =
  (input: { readonly sf: ts.SourceFile; readonly bindingName: string }) =>
  (expr: ts.Expression) =>
    RA.filterMap(extractNodeOccurrence(input.bindingName))(collectAllNodes(input.sf)(expr));

const extractBindingOccurrences = (sf: ts.SourceFile) => (b: BindingInfo) =>
  O.match<ts.Expression, ReadonlyArray<AccessorOccurrence>>(
    () => [],
    extractExprOccurrences({ sf, bindingName: b.name }),
  )(b.initializer);

const matchingBindingName = (targetChain: string) => (other: AccessorOccurrence) =>
  B.match<O.Option<string>>(
    () => O.none,
    () => O.some(other.bindingName),
  )(other.chainText === targetChain);

const hasAtLeastTwo = <A>(xs: ReadonlyArray<A>) => xs.length >= 2;

const isSharedOccurrence =
  (occurrences: ReadonlyArray<AccessorOccurrence>) => (occ: AccessorOccurrence) =>
    flow(RA.filterMap(matchingBindingName(occ.chainText)), RA.uniq(S.Eq), hasAtLeastTwo)(occurrences);

const getNodeLocation = (ctx: RuleContext) => ctx.inspector.getLocation(ctx.sourceFile);

const buildSharedAccessorHint =
  (ctx: RuleContext) =>
  (matchOcc: AccessorOccurrence): ReadonlyArray<AgentHint> => [
    {
      hintId: 'optic-shared-accessor',
      category: 'optic',
      priority: 'medium',
      location: getNodeLocation(ctx)(matchOcc.node),
      evidence: `Nested path \`${matchOcc.chainText}\` is accessed across multiple pipelines/bindings.`,
      suggestion:
        'Extract a shared `monocle-ts` Optic (`Lens.fromPath<Entity>()([...])`) when the same nested path is reused across multiple pipelines or updates.',
      suggestedSignature: O.none,
      researchQuestions: [
        `Can \`${matchOcc.chainText}\` be shared as a single \`Lens\` or \`Optional\` across these pipelines?`,
      ],
    },
  ];

const checkSharedNestedAccessors = (ctx: RuleContext) => {
  const occurrences = RA.chain(extractBindingOccurrences(ctx.sourceFile))(ctx.ir.bindings);
  return O.match<AccessorOccurrence, ReadonlyArray<AgentHint>>(
    () => [],
    buildSharedAccessorHint(ctx),
  )(RA.findFirst(isSharedOccurrence(occurrences))(occurrences));
};

const hasSpreadAssignment = (obj: ts.ObjectLiteralExpression) =>
  RA.some(ts.isSpreadAssignment)(obj.properties);

const isSpreadObjectLiteral = (n: ts.Node) =>
  O.exists(hasSpreadAssignment)(O.fromPredicate(ts.isObjectLiteralExpression)(n));

const isSpreadObjectProp = (prop: ts.ObjectLiteralElementLike) =>
  ts.isPropertyAssignment(prop) && isSpreadObjectLiteral(prop.initializer);

const hasNestedSpreadProp = (obj: ts.ObjectLiteralExpression) =>
  RA.some(isSpreadObjectProp)(obj.properties);

const isNestedSpreadUpdate = (n: ts.Node) =>
  O.exists(hasNestedSpreadProp)(O.fromPredicate(ts.isObjectLiteralExpression)(n));

const buildLensUpdateHint =
  (ctx: RuleContext) =>
  (node: ts.Node): ReadonlyArray<AgentHint> => [
    {
      hintId: 'optic-lens-update-candidate',
      category: 'optic',
      priority: 'medium',
      location: getNodeLocation(ctx)(node),
      evidence: 'Nested object spread performs an immutable multi-level update.',
      suggestion:
        'Replace nested object spreads with `monocle-ts` `Lens.fromPath<Entity>()([...]).set(...)` or `.modify(...)`.',
      suggestedSignature: O.none,
      researchQuestions: ['Can this nested immutable update be expressed with a composed `Lens`?'],
    },
  ];

const checkNestedImmutableUpdates = (ctx: RuleContext) => (nodes: ReadonlyArray<ts.Node>) =>
  O.match<ts.Node, ReadonlyArray<AgentHint>>(
    () => [],
    buildLensUpdateHint(ctx),
  )(RA.head(RA.filter(isNestedSpreadUpdate)(nodes)));

const isSpreadWithArrayMap = (sf: ts.SourceFile) => (n: ts.Node) =>
  isSpreadObjectLiteral(n) && /\.(map)\(|RA\.map\(/.test(n.getText(sf));

const buildTraversalHint =
  (ctx: RuleContext) =>
  (node: ts.Node): ReadonlyArray<AgentHint> => [
    {
      hintId: 'optic-traversal-candidate',
      category: 'optic',
      priority: 'medium',
      location: getNodeLocation(ctx)(node),
      evidence: 'Object spread combines shallow copy with nested array mapping.',
      suggestion:
        'Use a `monocle-ts` `Traversal` (`Lens.fromProp` composed with `fromTraversable(RA.Traversable)`) for declarative nested collection updates.',
      suggestedSignature: O.none,
      researchQuestions: ['Can this nested array update be composed as a reusable `Traversal`?'],
    },
  ];

const checkNestedArrayUpdates = (ctx: RuleContext) => (nodes: ReadonlyArray<ts.Node>) =>
  O.match<ts.Node, ReadonlyArray<AgentHint>>(
    () => [],
    buildTraversalHint(ctx),
  )(RA.head(RA.filter(isSpreadWithArrayMap(ctx.sourceFile))(nodes)));

const isFromNullableCall = (n: ts.Node) =>
  ts.isCallExpression(n) &&
  ts.isPropertyAccessExpression(n.expression) &&
  getPropNameText(n.expression) === 'fromNullable';

const buildOptionalPrismHint =
  (input: { readonly ctx: RuleContext; readonly count: number }) =>
  (node: ts.Node): ReadonlyArray<AgentHint> => [
    {
      hintId: 'optic-optional-prism-candidate',
      category: 'optic',
      priority: 'low',
      location: getNodeLocation(input.ctx)(node),
      evidence: `Detected ${input.count} \`fromNullable\` lifts that may represent a deep optional traversal.`,
      suggestion:
        'Consider composing `monocle-ts` `Optional` / `Prism` (`Lens.fromNullableProp` or `Prism.fromPredicate`) for deep optional or sum-type traversals.',
      suggestedSignature: O.none,
      researchQuestions: [
        'Are these nullable lifts traversing a nested optional structure or sum type?',
      ],
    },
  ];

const checkDeepOptionalTraversals = (ctx: RuleContext) => (nodes: ReadonlyArray<ts.Node>) => {
  const nullableLifts = RA.filter(isFromNullableCall)(nodes);
  return B.match<ReadonlyArray<AgentHint>>(
    () => [],
    () =>
      O.match<ts.Node, ReadonlyArray<AgentHint>>(
        () => [],
        buildOptionalPrismHint({ ctx, count: nullableLifts.length }),
      )(RA.head(nullableLifts)),
  )(nullableLifts.length >= 2);
};

export const detectOpticsHints = ((ctx: RuleContext): ReadonlyArray<AgentHint> => {
  const nodes = collectAllNodes(ctx.sourceFile)(ctx.sourceFile);
  return [
    ...checkSharedNestedAccessors(ctx),
    ...checkNestedImmutableUpdates(ctx)(nodes),
    ...checkNestedArrayUpdates(ctx)(nodes),
    ...checkDeepOptionalTraversals(ctx)(nodes),
  ];
}) satisfies HintRunner;
