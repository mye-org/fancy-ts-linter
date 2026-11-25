import { constant, flow } from 'fp-ts/lib/function.js';
import * as O from 'fp-ts/lib/Option.js';
import * as RA from 'fp-ts/lib/ReadonlyArray.js';
import { Lens } from 'monocle-ts';
import { match, P } from 'ts-pattern';
import type * as ts from 'typescript';
import * as tsApi from 'typescript';
import type { AgentHint, BindingInfo, RuleContext } from '../model/report.js';

export type HintRunner = (ctx: RuleContext) => ReadonlyArray<AgentHint>;

type QueueStep = {
  readonly sf: ts.SourceFile;
  readonly queue: ReadonlyArray<ts.Node>;
};

type HandlerMatchInput = {
  readonly sf: ts.SourceFile;
  readonly hName: string;
};

type BindingMatcherInput = {
  readonly ruleContext: RuleContext;
  readonly b: BindingInfo;
};

type MatcherTarget = {
  readonly ruleContext: RuleContext;
  readonly b: BindingInfo;
  readonly expr: ts.Expression;
};

type RawMatcherInfo = {
  readonly b: BindingInfo;
  readonly shallowWithsCount: number;
  readonly handlerNames: ReadonlyArray<string>;
  readonly exprText: string;
};

type MatcherAnalysis =
  | {
      readonly _tag: 'NestedHandlerBranch';
      readonly b: BindingInfo;
      readonly handlerNames: ReadonlyArray<string>;
    }
  | {
      readonly _tag: 'FlatShallowCases';
      readonly b: BindingInfo;
      readonly handlerNames: ReadonlyArray<string>;
    }
  | { readonly _tag: 'SufficientDepth' };

const bindingsLens = Lens.fromPath<RuleContext>()(['ir', 'bindings']);
const callNameLens = Lens.fromPath<ts.PropertyAccessExpression>()(['name', 'text']);
const locLineLens = Lens.fromPath<BindingInfo>()(['location', 'line']);
const locColumnLens = Lens.fromPath<BindingInfo>()(['location', 'column']);

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

const doesNotIncludeP =
  (sf: ts.SourceFile) =>
  (arg: ts.Expression) =>
    !arg.getText(sf).includes('P.');

const isShallowTagWith =
  (sf: ts.SourceFile) =>
  ({ expression, arguments: args }: ts.CallExpression) =>
    tsApi.isPropertyAccessExpression(expression) &&
    callNameLens.get(expression) === 'with' &&
    args.length >= 2 &&
    O.exists(doesNotIncludeP(sf))(RA.head(args));

const isShallowCallWith =
  (sf: ts.SourceFile) =>
  (n: ts.Node): n is ts.CallExpression =>
    tsApi.isCallExpression(n) && isShallowTagWith(sf)(n);

const getSecondArg = ({ arguments: args }: ts.CallExpression) => RA.lookup(1)(args);
const getIdentifierText = (id: ts.Identifier) => id.text;

const extractHandlerName = flow(
  getSecondArg,
  O.filter(tsApi.isIdentifier),
  O.map(getIdentifierText),
);

const hasNestedMatchText =
  (sf: ts.SourceFile) =>
  (he: ts.Expression) =>
    /\b(fromPredicate|B\.match|match\()\b/.test(he.getText(sf));

const isBranchingHandlerBinding =
  ({ sf, hName }: HandlerMatchInput) =>
  (hb: BindingInfo) =>
    hb.name === hName &&
    (hb.kind === 'adt-matcher' || O.exists(hasNestedMatchText(sf))(hb.initializer));

const hasHandlerNestedBranch =
  (ctx: RuleContext) =>
  (hName: string) =>
    RA.exists(isBranchingHandlerBinding({ sf: ctx.sourceFile, hName }))(bindingsLens.get(ctx));

const classifyMatcher =
  (ctx: RuleContext) =>
  ({ b, shallowWithsCount, handlerNames, exprText }: RawMatcherInfo): MatcherAnalysis =>
    match({
      hasNested: RA.some(hasHandlerNestedBranch(ctx))(handlerNames),
      usesDeepPattern: exprText.includes('P.select') || exprText.includes('P.when'),
      hasMultipleShallow: shallowWithsCount >= 2,
    })
      .with({ hasNested: true }, constant({ _tag: 'NestedHandlerBranch' as const, b, handlerNames }))
      .with(
        { usesDeepPattern: false, hasMultipleShallow: true },
        constant({ _tag: 'FlatShallowCases' as const, b, handlerNames }),
      )
      .otherwise(constant({ _tag: 'SufficientDepth' as const }));

const buildMatcherAnalysis =
  ({ ruleContext, b, expr }: MatcherTarget) =>
  (shallowWiths: ReadonlyArray<ts.CallExpression>) =>
    classifyMatcher(ruleContext)({
      b,
      shallowWithsCount: shallowWiths.length,
      handlerNames: RA.filterMap(extractHandlerName)(shallowWiths),
      exprText: expr.getText(ruleContext.sourceFile),
    });

const sourceFileLens = Lens.fromPath<MatcherTarget>()(['ruleContext', 'sourceFile']);

const analyzeMatcherExpr = (target: MatcherTarget) =>
  flow(
    collectAllNodes(sourceFileLens.get(target)),
    RA.filter(isShallowCallWith(sourceFileLens.get(target))),
    buildMatcherAnalysis(target),
  )(target.expr);

const makeDepthHint = ({
  b,
  priority,
  evidence,
  handlerNames,
}: {
  readonly b: BindingInfo;
  readonly priority: 'high' | 'medium';
  readonly evidence: string;
  readonly handlerNames: ReadonlyArray<string>;
}) => ({
  hintId: `pattern-depth-${b.name}`,
  category: 'pattern-matching-depth' as const,
  priority,
  location: { line: locLineLens.get(b), column: locColumnLens.get(b) },
  evidence,
  suggestion:
    'Leverage `ts-pattern` deep structural matching: match nested fields directly with `P.when(pred)`, extract values with `P.select()`, or combine states with `match([a, b])`.',
  suggestedSignature: O.none,
  researchQuestions: [
    `Can secondary checks inside \`${handlerNames.join(', ')}\` be expressed directly in \`.with({ _tag: ..., field: P.when(...) }, ...)\`?`,
  ],
});

const toNestedHandlerHint = ({
  b,
  handlerNames,
}: {
  readonly b: BindingInfo;
  readonly handlerNames: ReadonlyArray<string>;
}) =>
  O.some(
    makeDepthHint({
      b,
      priority: 'high',
      evidence: `\`${b.name}\` uses shallow \`ts-pattern\` tag matching whose handlers branch again.`,
      handlerNames,
    }),
  );

const toFlatShallowHint = ({
  b,
  handlerNames,
}: {
  readonly b: BindingInfo;
  readonly handlerNames: ReadonlyArray<string>;
}) =>
  O.some(
    makeDepthHint({
      b,
      priority: 'medium',
      evidence: `\`${b.name}\` uses flat \`match\` cases without structural patterns (\`P.select\`, \`P.when\`, \`P.union\`).`,
      handlerNames,
    }),
  );

const toPatternDepthHint = (analysis: MatcherAnalysis) =>
  match(analysis)
    .with(
      { _tag: 'NestedHandlerBranch', b: P.select('b'), handlerNames: P.select('handlerNames') },
      toNestedHandlerHint,
    )
    .with(
      { _tag: 'FlatShallowCases', b: P.select('b'), handlerNames: P.select('handlerNames') },
      toFlatShallowHint,
    )
    .with({ _tag: 'SufficientDepth' }, constant(O.none))
    .exhaustive();

const toMatcherTarget =
  ({ ruleContext, b }: BindingMatcherInput) =>
  (expr: ts.Expression): MatcherTarget => ({ ruleContext, b, expr });

const checkMatcherDepth =
  (ruleContext: RuleContext) =>
  (b: BindingInfo) =>
    flow(
      O.map(toMatcherTarget({ ruleContext, b })),
      O.map(analyzeMatcherExpr),
      O.chain(toPatternDepthHint),
      O.match(RA.zero<AgentHint>, RA.of),
    )(b.initializer);

const isAdtMatcher = (b: BindingInfo) => b.kind === 'adt-matcher';

const runPatternDepthHints = (ctx: RuleContext) =>
  flow(
    bindingsLens.get,
    RA.filter(isAdtMatcher),
    RA.chain(checkMatcherDepth(ctx)),
  )(ctx);

const identityCtx = (ctx: RuleContext) => ctx;

export const detectPatternMatchingDepthHints = flow(
  identityCtx,
  runPatternDepthHints,
) satisfies HintRunner;


