import * as B from 'fp-ts/lib/boolean.js';
import { constant } from 'fp-ts/lib/function.js';
import * as O from 'fp-ts/lib/Option.js';
import * as RA from 'fp-ts/lib/ReadonlyArray.js';
import { Lens } from 'monocle-ts';
import * as ts from 'typescript';
import { iso } from 'newtype-ts';
import type { AgentHint, BindingInfo, RuleContext, HintEvidence, HintId, HintSuggestion, SymbolName } from '../model/report.js';

const isoHintId = iso<HintId>();
const isoHintEvidence = iso<HintEvidence>();
const isoHintSuggestion = iso<HintSuggestion>();
const isoSymbolName = iso<SymbolName>();

export type HintRunner = (ctx: RuleContext) => ReadonlyArray<AgentHint>;

type ExprContext = {
  readonly ctx: RuleContext;
  readonly b: BindingInfo;
};

type QueueContext = {
  readonly sf: ts.SourceFile;
  readonly queue: ReadonlyArray<ts.Node>;
};

type HeadContext = {
  readonly sf: ts.SourceFile;
  readonly head: ts.Node;
};

const bindingLineLens = Lens.fromPath<BindingInfo>()(['location', 'line']);
const bindingColLens = Lens.fromPath<BindingInfo>()(['location', 'column']);

const withChildren =
  ({ sf, head }: HeadContext) =>
  (tail: ReadonlyArray<ts.Node>) =>
    [head, [...head.getChildren(sf), ...tail]] as const;

const expandHead =
  ({ sf, queue }: QueueContext) =>
  (head: ts.Node) =>
    O.map(withChildren({ sf, head }))(RA.tail(queue));

const unfoldNodeQueue =
  (sf: ts.SourceFile) =>
  (queue: ReadonlyArray<ts.Node>) =>
    O.chain(expandHead({ sf, queue }))(RA.head(queue));

const collectAllNodes = (sf: ts.SourceFile) => (root: ts.Node) =>
  RA.unfold([root], unfoldNodeQueue(sf));

const isIdentifierNamed = (name: string) => (n: ts.Node) =>
  ts.isIdentifier(n) && n.text === name;

const makeRecursiveHint = (b: BindingInfo) => {
  const hints: ReadonlyArray<AgentHint> = [
    {
      hintId: isoHintId.wrap(`declarative-recursion-${b.name}`),
      category: 'declarative-combinator',
      priority: 'high',
      location: { line: bindingLineLens.get(b), column: bindingColLens.get(b) },
      evidence: isoHintEvidence.wrap(`\`${b.name}\` uses explicit self-recursion.`),
      suggestion: isoHintSuggestion.wrap('Prefer declarative `fp-ts/ReadonlyArray` combinators (`RA.unfold`, `RA.traverse`, `RA.foldMap`, `Monoid.concatAll`) over manual recursion.'),
      suggestedSignature: O.none,
      researchQuestions: [`Can \`${b.name}\` be expressed as a fold, unfold, or traverse?`],
    },
  ];
  return hints;
};

const makeReduceHint = (b: BindingInfo) => {
  const hints: ReadonlyArray<AgentHint> = [
    {
      hintId: isoHintId.wrap(`declarative-reduce-${b.name}`),
      category: 'declarative-combinator',
      priority: 'low',
      location: { line: bindingLineLens.get(b), column: bindingColLens.get(b) },
      evidence: isoHintEvidence.wrap(`\`${b.name}\` uses \`reduce\`.`),
      suggestion: isoHintSuggestion.wrap('Verify whether `RA.filterMap`, `RA.partitionMap`, `RA.traverse`, or `Monoid.concatAll` expresses the intent more declaratively than `reduce`.'),
      suggestedSignature: O.none,
      researchQuestions: [
        `Is \`${b.name}\` building a filtered/partitioned collection or combining a Monoid?`,
      ],
    },
  ];
  return hints;
};

const checkExprDeclarative =
  ({ ctx, b }: ExprContext) =>
  (expr: ts.Expression): ReadonlyArray<AgentHint> => {
    const text = expr.getText(ctx.sourceFile);
    const nodes = collectAllNodes(ctx.sourceFile)(expr);
    const isSelfRecursive =
      b.kind === 'leaf-fn' && RA.some(isIdentifierNamed(isoSymbolName.unwrap(b.name)))(nodes);
    const usesManualReduce = /\b(RA|A)\.reduce\b/.test(text);
    const recursiveHint = B.match(
      RA.zero<AgentHint>,
      constant(makeRecursiveHint(b)),
    )(isSelfRecursive);
    const reduceHint = B.match(
      RA.zero<AgentHint>,
      constant(makeReduceHint(b)),
    )(usesManualReduce);
    return [...recursiveHint, ...reduceHint];
  };

const checkBindingDeclarative = (ctx: RuleContext) => (b: BindingInfo) =>
  O.match(RA.zero<AgentHint>, checkExprDeclarative({ ctx, b }))(b.initializer);

export const detectDeclarativeCombinatorHints = ((ctx: RuleContext): ReadonlyArray<AgentHint> =>
  RA.chain(checkBindingDeclarative(ctx))(ctx.ir.bindings)) satisfies HintRunner;
