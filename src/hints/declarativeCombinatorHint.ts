import * as B from 'fp-ts/lib/boolean.js';
import { constant, flow } from 'fp-ts/lib/function.js';
import * as O from 'fp-ts/lib/Option.js';
import * as RA from 'fp-ts/lib/ReadonlyArray.js';
import * as RNEA from 'fp-ts/lib/ReadonlyNonEmptyArray.js';
import * as ts from 'typescript';
import type { AgentHint, BindingInfo, RuleContext } from '../model/report.js';

export type HintRunner = (ctx: RuleContext) => ReadonlyArray<AgentHint>;

type BindingExprInput = {
  readonly ctx: RuleContext;
  readonly b: BindingInfo;
};

const stepAstQueue =
  (sf: ts.SourceFile) =>
  (nonEmpty: RNEA.ReadonlyNonEmptyArray<ts.Node>) =>
    [
      RNEA.head(nonEmpty),
      [...RNEA.head(nonEmpty).getChildren(sf), ...RNEA.tail(nonEmpty)],
    ] as const;

const unfoldAstStep = (sf: ts.SourceFile) =>
  flow(O.fromPredicate(RA.isNonEmpty<ts.Node>), O.map(stepAstQueue(sf)));

const collectAllNodes =
  (sf: ts.SourceFile) =>
  (node: ts.Node) =>
    RA.unfold(RA.of(node), unfoldAstStep(sf));

const isIdentifierNamed =
  (name: string) =>
  (n: ts.Node) =>
    ts.isIdentifier(n) && n.text === name;

const buildRecursiveHint = (b: BindingInfo) => [
  {
    hintId: `declarative-recursion-${b.name}`,
    category: 'declarative-combinator' as const,
    priority: 'medium' as const,
    location: { line: b.location.line, column: b.location.column },
    evidence: `\`${b.name}\` uses explicit self-recursion.`,
    suggestion:
      'Prefer declarative `fp-ts/ReadonlyArray` combinators (`RA.unfold`, `RA.traverse`, `RA.reduce`, `Monoid.concatAll`) over manual recursion.',
    suggestedSignature: O.none,
    researchQuestions: [`Can \`${b.name}\` be expressed as a fold, unfold, or traverse?`],
  },
];

const buildReduceHint = (b: BindingInfo) => [
  {
    hintId: `declarative-reduce-${b.name}`,
    category: 'declarative-combinator' as const,
    priority: 'low' as const,
    location: { line: b.location.line, column: b.location.column },
    evidence: `\`${b.name}\` uses \`reduce\`.`,
    suggestion:
      'Verify whether `RA.filterMap`, `RA.partitionMap`, `RA.traverse`, or `Monoid.concatAll` expresses the intent more declaratively than `reduce`.',
    suggestedSignature: O.none,
    researchQuestions: [`Is \`${b.name}\` building a filtered/partitioned collection or combining a Monoid?`],
  },
];

const checkExprDeclarative =
  (input: BindingExprInput) =>
  (expr: ts.Expression) => [
    ...B.match(constant(RA.zero<AgentHint>()), constant(buildRecursiveHint(input.b)))(
      input.b.kind === 'leaf-fn' &&
        RA.some(isIdentifierNamed(input.b.name))(collectAllNodes(input.ctx.sourceFile)(expr)),
    ),
    ...B.match(constant(RA.zero<AgentHint>()), constant(buildReduceHint(input.b)))(
      /\b(?:RA|A)\.reduce\b/.test(expr.getText(input.ctx.sourceFile)),
    ),
  ];

const checkBindingDeclarative =
  (ctx: RuleContext) =>
  (b: BindingInfo) =>
    O.match(constant(RA.zero<AgentHint>()), checkExprDeclarative({ ctx, b }))(b.initializer);

const runDeclarativeHints = (ctx: RuleContext) =>
  RA.chain(checkBindingDeclarative(ctx))(ctx.ir.bindings);

const identityCtx = (ctx: RuleContext) => ctx;

export const detectDeclarativeCombinatorHints = flow(
  identityCtx,
  runDeclarativeHints,
) satisfies HintRunner;
