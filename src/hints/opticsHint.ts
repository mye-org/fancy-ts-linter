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

const isNonLibChain = (chainText: string): boolean =>
  !/^(O|E|TE|T|RA|RR|B|P|Lens|Prism|Optional|Traversal)\./.test(chainText);

type AccessorOccurrence = {
  readonly bindingName: string;
  readonly chainText: string;
  readonly node: ts.Node;
};

const checkSharedNestedAccessors = (ctx: RuleContext): ReadonlyArray<AgentHint> => {
  const occurrences: ReadonlyArray<AccessorOccurrence> = RA.chain(
    (b: (typeof ctx.ir.bindings)[number]) =>
      O.match(
        () => [] as ReadonlyArray<AccessorOccurrence>,
        (expr: ts.Expression) =>
          RA.filterMap((n: ts.Node) =>
            ts.isPropertyAccessExpression(n)
              ? O.chain((chainText: string) =>
                  isNonLibChain(chainText)
                    ? O.some({ bindingName: b.name, chainText, node: n })
                    : O.none,
                )(getNestedChainText(ctx.sourceFile)(n))
              : O.none,
          )(collectAllNodes(ctx.sourceFile)(expr)),
      )(b.initializer),
  )(ctx.ir.bindings);

  const shared = RA.findFirst((occ: AccessorOccurrence) => {
    const distinctBindings = RA.uniq({
      equals: (a: string, b: string) => a === b,
    })(
      RA.filterMap((other: AccessorOccurrence) =>
        other.chainText === occ.chainText ? O.some(other.bindingName) : O.none,
      )(occurrences),
    );
    return distinctBindings.length >= 2;
  })(occurrences);

  return O.match(
    () => [] as ReadonlyArray<AgentHint>,
    (matchOcc: AccessorOccurrence) => [
      {
        hintId: 'optic-shared-accessor',
        category: 'optic' as const,
        priority: 'medium' as const,
        location: ctx.inspector.getLocation(ctx.sourceFile)(matchOcc.node),
        evidence: `Nested path \`${matchOcc.chainText}\` is accessed across multiple pipelines/bindings.`,
        suggestion:
          'Extract a shared `monocle-ts` Optic (`Lens.fromPath<Entity>()([...])`) when the same nested path is reused across multiple pipelines or updates.',
        suggestedSignature: O.none,
        researchQuestions: [
          `Can \`${matchOcc.chainText}\` be shared as a single \`Lens\` or \`Optional\` across these pipelines?`,
        ],
      },
    ],
  )(shared);
};

const checkNestedImmutableUpdates =
  (ctx: RuleContext) =>
  (nodes: ReadonlyArray<ts.Node>): ReadonlyArray<AgentHint> => {
    const nestedSpreadUpdates = RA.filter((n: ts.Node): n is ts.ObjectLiteralExpression => {
      if (!ts.isObjectLiteralExpression(n) || !RA.some(ts.isSpreadAssignment)(n.properties)) {
        return false;
      }
      return RA.some(
        (prop: ts.ObjectLiteralElementLike) =>
          ts.isPropertyAssignment(prop) &&
          ts.isObjectLiteralExpression(prop.initializer) &&
          RA.some(ts.isSpreadAssignment)(prop.initializer.properties),
      )(n.properties);
    })(nodes);

    return RA.isNonEmpty(nestedSpreadUpdates)
      ? [
          {
            hintId: 'optic-lens-update-candidate',
            category: 'optic',
            priority: 'medium',
            location: ctx.inspector.getLocation(ctx.sourceFile)(nestedSpreadUpdates[0]!),
            evidence: 'Nested object spread performs an immutable multi-level update.',
            suggestion:
              'Replace nested object spreads with `monocle-ts` `Lens.fromPath<Entity>()([...]).set(...)` or `.modify(...)`.',
            suggestedSignature: O.none,
            researchQuestions: [
              'Can this nested immutable update be expressed with a composed `Lens`?',
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

const checkDeepOptionalTraversals =
  (ctx: RuleContext) =>
  (nodes: ReadonlyArray<ts.Node>): ReadonlyArray<AgentHint> => {
    const nullableLifts = RA.filter(
      (n: ts.Node): n is ts.CallExpression =>
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        n.expression.name.text === 'fromNullable',
    )(nodes);

    return nullableLifts.length >= 2
      ? [
          {
            hintId: 'optic-optional-prism-candidate',
            category: 'optic',
            priority: 'low',
            location: ctx.inspector.getLocation(ctx.sourceFile)(nullableLifts[0]!),
            evidence: `Detected ${nullableLifts.length} \`fromNullable\` lifts that may represent a deep optional traversal.`,
            suggestion:
              'Consider composing `monocle-ts` `Optional` / `Prism` (`Lens.fromNullableProp` or `Prism.fromPredicate`) for deep optional or sum-type traversals.',
            suggestedSignature: O.none,
            researchQuestions: [
              'Are these nullable lifts traversing a nested optional structure or sum type?',
            ],
          },
        ]
      : [];
  };

const runOpticsHints = (ctx: RuleContext): ReadonlyArray<AgentHint> => {
  const nodes = collectAllNodes(ctx.sourceFile)(ctx.sourceFile);
  return [
    ...checkSharedNestedAccessors(ctx),
    ...checkNestedImmutableUpdates(ctx)(nodes),
    ...checkNestedArrayUpdates(ctx)(nodes),
    ...checkDeepOptionalTraversals(ctx)(nodes),
  ];
};

const identityCtx = (ctx: RuleContext) => ctx;

export const detectOpticsHints = flow(
  identityCtx,
  runOpticsHints,
) satisfies HintRunner;
