import { flow } from 'fp-ts/lib/function.js';
import * as O from 'fp-ts/lib/Option.js';
import * as RA from 'fp-ts/lib/ReadonlyArray.js';
import * as ts from 'typescript';
import type { AgentHint, BindingInfo, RuleContext } from '../model/report.js';

export type HintRunner = (ctx: RuleContext) => ReadonlyArray<AgentHint>;

const collectAllNodes = (sf: ts.SourceFile) => (node: ts.Node): ReadonlyArray<ts.Node> => [
  node,
  ...RA.chain(collectAllNodes(sf))(node.getChildren(sf)),
];

const checkBindingDeclarative = (ctx: RuleContext) => (b: BindingInfo): ReadonlyArray<AgentHint> =>
  O.match(
    () => [] as ReadonlyArray<AgentHint>,
    (expr: ts.Expression): ReadonlyArray<AgentHint> => {
      const text = expr.getText(ctx.sourceFile);
      const nodes = collectAllNodes(ctx.sourceFile)(expr);

      const isSelfRecursive =
        b.kind === 'leaf-fn' &&
        RA.some((n: ts.Node) => ts.isIdentifier(n) && n.text === b.name)(nodes);

      const usesManualReduce = /\b(RA|A)\.reduce\b/.test(text);

      const recursiveHint: ReadonlyArray<AgentHint> = isSelfRecursive
        ? [
            {
              hintId: `declarative-recursion-${b.name}`,
              category: 'declarative-combinator',
              priority: 'medium',
              location: { line: b.location.line, column: b.location.column },
              evidence: `\`${b.name}\` uses explicit self-recursion.`,
              suggestion:
                'Prefer declarative `fp-ts/ReadonlyArray` combinators (`RA.unfold`, `RA.traverse`, `RA.reduce`, `Monoid.concatAll`) over manual recursion.',
              suggestedSignature: O.none,
              researchQuestions: [`Can \`${b.name}\` be expressed as a fold, unfold, or traverse?`],
            },
          ]
        : [];

      const reduceHint: ReadonlyArray<AgentHint> = usesManualReduce
        ? [
            {
              hintId: `declarative-reduce-${b.name}`,
              category: 'declarative-combinator',
              priority: 'low',
              location: { line: b.location.line, column: b.location.column },
              evidence: `\`${b.name}\` uses \`reduce\`.`,
              suggestion:
                'Verify whether `RA.filterMap`, `RA.partitionMap`, `RA.traverse`, or `Monoid.concatAll` expresses the intent more declaratively than `reduce`.',
              suggestedSignature: O.none,
              researchQuestions: [`Is \`${b.name}\` building a filtered/partitioned collection or combining a Monoid?`],
            },
          ]
        : [];

      return [...recursiveHint, ...reduceHint];
    },
  )(b.initializer);

const runDeclarativeHints = (ctx: RuleContext): ReadonlyArray<AgentHint> =>
  RA.chain(checkBindingDeclarative(ctx))(ctx.ir.bindings);

const identityCtx = (ctx: RuleContext) => ctx;

export const detectDeclarativeCombinatorHints = flow(
  identityCtx,
  runDeclarativeHints,
) satisfies HintRunner;
