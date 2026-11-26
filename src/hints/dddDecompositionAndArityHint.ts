import * as B from 'fp-ts/lib/boolean.js';
import { constant } from 'fp-ts/lib/function.js';
import * as O from 'fp-ts/lib/Option.js';
import * as RA from 'fp-ts/lib/ReadonlyArray.js';
import { Lens } from 'monocle-ts';
import * as ts from 'typescript';
import type { AgentHint, BindingInfo, RuleContext } from '../model/report.js';

export type HintRunner = (ctx: RuleContext) => ReadonlyArray<AgentHint>;

type QueueContext = {
  readonly sf: ts.SourceFile;
  readonly queue: ReadonlyArray<ts.Node>;
};

type HeadContext = {
  readonly sf: ts.SourceFile;
  readonly head: ts.Node;
};

type FlowStepInput = {
  readonly ctx: RuleContext;
  readonly b: BindingInfo;
};

type FlowLengthHintInput = {
  readonly b: BindingInfo;
  readonly steps: number;
  readonly maxFlowSteps: number;
};

type ArityHintInput = {
  readonly ctx: RuleContext;
  readonly n: ts.ArrowFunction;
};

type CurryHintInput = {
  readonly ctx: RuleContext;
  readonly n: ts.ArrowFunction;
  readonly depth: number;
};

const bindingLineLens = Lens.fromPath<BindingInfo>()(['location', 'line']);
const bindingColLens = Lens.fromPath<BindingInfo>()(['location', 'column']);
const bindingEffectsLens = Lens.fromProp<BindingInfo>()('effects');
const ctxBindingsLens = Lens.fromPath<RuleContext>()(['ir', 'bindings']);

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

const makeFlowLengthHint = ({ b, steps, maxFlowSteps }: FlowLengthHintInput) => {
  const hints: ReadonlyArray<AgentHint> = [
    {
      hintId: `ddd-flow-length-${b.name}`,
      category: 'ddd-decomposition',
      priority: 'high',
      location: { line: bindingLineLens.get(b), column: bindingColLens.get(b) },
      evidence: `Pipeline \`${b.name}\` has ${steps} steps (threshold: ${maxFlowSteps}).`,
      suggestion:
        'Decompose this long `flow(...)` into 2–4 domain-meaningful sub-flows (`const validateOrder = flow(...)`, `const applyPricing = flow(...)`, `export const main = flow(validateOrder, applyPricing)`).',
      suggestedSignature: O.none,
      researchQuestions: [
        'Which contiguous steps form a cohesive DDD phase (Validation, Domain Transform, Persistence/I/O)?',
      ],
    },
  ];
  return hints;
};

const checkFlowStepCount =
  ({ ctx, b }: FlowStepInput) =>
  (steps: number) =>
    B.match(
      RA.zero<AgentHint>,
      constant(makeFlowLengthHint({ b, steps, maxFlowSteps: ctx.options.maxFlowSteps })),
    )(steps > ctx.options.maxFlowSteps);

const checkBindingFlowLength = (ctx: RuleContext) => (b: BindingInfo) =>
  O.match(RA.zero<AgentHint>, checkFlowStepCount({ ctx, b }))(b.stepCount);

const checkLongFlows = (ctx: RuleContext) =>
  RA.chain(checkBindingFlowLength(ctx))(ctxBindingsLens.get(ctx));

const isPureBinding = (b: BindingInfo) => bindingEffectsLens.get(b).includes('Pure');

const isAsyncEffectBinding = (b: BindingInfo) => {
  const effects = bindingEffectsLens.get(b);
  return (
    effects.includes('TaskEither') ||
    effects.includes('ReaderTaskEither') ||
    effects.includes('Task')
  );
};

const isExportedFlow = (b: BindingInfo) => b.kind === 'exported-flow';

const gte6 = (n: number) => n >= 6;

const makePureCoreIoShellHint = (b: BindingInfo) => {
  const hints: ReadonlyArray<AgentHint> = [
    {
      hintId: 'ddd-pure-core-io-shell',
      category: 'ddd-decomposition',
      priority: 'medium',
      location: { line: bindingLineLens.get(b), column: bindingColLens.get(b) },
      evidence: `\`${b.name}\` orchestrates both pure domain logic and async I/O (\`TaskEither\`/\`ReaderTaskEither\`) in one flat pipeline.`,
      suggestion:
        'Group pure domain steps into a synchronous sub-flow (`Either` / `Option`) and keep async I/O steps in a separate shell sub-flow.',
      suggestedSignature: O.none,
      researchQuestions: [
        'Can all pure business rules be tested independently as a pure `Either` sub-flow?',
      ],
    },
  ];
  return hints;
};

const checkExportedFlow = (b: BindingInfo) =>
  B.match(RA.zero<AgentHint>, constant(makePureCoreIoShellHint(b)))(
    O.exists(gte6)(b.stepCount),
  );

const checkMixedPureAndIo = (ctx: RuleContext) => {
  const bindings = ctxBindingsLens.get(ctx);
  const hasPure = RA.some(isPureBinding)(bindings);
  const hasAsyncEffect = RA.some(isAsyncEffectBinding)(bindings);
  const exportedFlow = RA.findFirst(isExportedFlow)(bindings);
  return B.match(
    RA.zero<AgentHint>,
    constant(O.match(RA.zero<AgentHint>, checkExportedFlow)(exportedFlow)),
  )(hasPure && hasAsyncEffect);
};

const isFunctionLikeParam = (checker: ts.TypeChecker) => (p: ts.ParameterDeclaration) =>
  checker.getTypeAtLocation(p).getCallSignatures().length > 0;

const isFnOrConfigParam = (ctx: RuleContext) => (p: ts.ParameterDeclaration) =>
  isFunctionLikeParam(ctx.checker)(p) ||
  /config|env|deps|predicate|fn|rate|factor|threshold/i.test(p.name.getText(ctx.sourceFile));

const makeArityStrategyHint = ({ ctx, n }: ArityHintInput) => {
  const hasFnOrConfig = RA.some(isFnOrConfigParam(ctx))(n.parameters);
  const loc = ctx.inspector.getLocation(ctx.sourceFile)(n);
  const suggestion = B.match(
    constant(
      'Bundle cohesive peer parameters into a single named **Domain Record** type (`export type Input = { ... }`).',
    ),
    constant(
      'Keep currying to **at most 2–3 levels** (`(configOrContext) => (input: InputRecord) => result`) and only when outer args are partially applied; otherwise use a single named **Domain/Input Record**.',
    ),
  )(hasFnOrConfig);

  const hints: ReadonlyArray<AgentHint> = [
    {
      hintId: `arity-strategy-${loc.line}-${loc.column}`,
      category: 'arity-strategy',
      priority: 'high',
      location: { line: loc.line, column: loc.column },
      evidence: `Function at line ${loc.line} has ${n.parameters.length} parameters.`,
      suggestion,
      suggestedSignature: O.none,
      researchQuestions: [
        'Are these parameters configuration/behavior reused across calls (2-step curry) or peer fields of one call (Domain Record)?',
      ],
    },
  ];
  return hints;
};

const checkArrowMultiParam = (ctx: RuleContext) => (n: ts.ArrowFunction) =>
  B.match(RA.zero<AgentHint>, constant(makeArityStrategyHint({ ctx, n })))(
    n.parameters.length > 1,
  );

const checkNodeMultiParam = (ctx: RuleContext) => (n: ts.Node) =>
  O.match(RA.zero<AgentHint>, checkArrowMultiParam(ctx))(
    O.fromPredicate(ts.isArrowFunction)(n),
  );

const checkMultiParamArityStrategy = (ctx: RuleContext) => {
  const nodes = collectAllNodes(ctx.sourceFile)(ctx.sourceFile);
  return RA.chain(checkNodeMultiParam(ctx))(nodes);
};

const pairSame = <A>(a: A) => [a, a] as const;

const pairParenExpr = (p: ts.ParenthesizedExpression) => pairSame(p.expression);

const stepParen = (expr: ts.Expression) =>
  O.map(pairParenExpr)(O.fromPredicate(ts.isParenthesizedExpression)(expr));

const unwrapParens = (node: ts.Expression) =>
  O.getOrElse(constant(node))(RA.last(RA.unfold(node, stepParen)));

const isExpressionBody = (body: ts.ConciseBody): body is ts.Expression => !ts.isBlock(body);

const nextCurriedArrow = (arrow: ts.ArrowFunction) =>
  O.chain(O.fromPredicate(ts.isArrowFunction))(
    O.map(unwrapParens)(O.fromPredicate(isExpressionBody)(arrow.body)),
  );

const stepCurryArrow = (arrow: ts.ArrowFunction) =>
  O.map(pairSame<ts.ArrowFunction>)(nextCurriedArrow(arrow));

const countCurryDepth = (arrow: ts.ArrowFunction) =>
  1 + RA.unfold(arrow, stepCurryArrow).length;

const isCurriedRoot = (n: ts.Node): n is ts.ArrowFunction =>
  ts.isArrowFunction(n) && !(n.parent !== undefined && ts.isArrowFunction(n.parent));

const makeDeepCurryHint = ({ ctx, n, depth }: CurryHintInput) => {
  const loc = ctx.inspector.getLocation(ctx.sourceFile)(n);
  const priority = B.match(constant('medium' as const), constant('high' as const))(depth >= 4);
  const hints: ReadonlyArray<AgentHint> = [
    {
      hintId: `arity-curry-depth-${loc.line}-${loc.column}`,
      category: 'arity-strategy',
      priority,
      location: { line: loc.line, column: loc.column },
      evidence: `Curried function at line ${loc.line} has ${depth} nested parameter levels.`,
      suggestion:
        'Avoid long curried chains (positional ambiguity, closure & type-checking overhead). Collapse parameters into a single named input object (`(input: FnInput) => ...`), or use a 2-step curry (`(ctx) => (input: FnInput) => ...`) only if the outer argument is partially applied.',
      suggestedSignature: O.none,
      researchQuestions: [
        'Are all arguments supplied at once at call sites (use a single input record), or is the outer argument genuinely reused via partial application (2-step curry)?',
      ],
    },
  ];
  return hints;
};

const checkCurriedRoot = (ctx: RuleContext) => (n: ts.ArrowFunction) => {
  const depth = countCurryDepth(n);
  return B.match(RA.zero<AgentHint>, constant(makeDeepCurryHint({ ctx, n, depth })))(
    depth >= 3,
  );
};

const checkNodeCurryChain = (ctx: RuleContext) => (n: ts.Node) =>
  O.match(RA.zero<AgentHint>, checkCurriedRoot(ctx))(O.fromPredicate(isCurriedRoot)(n));

const checkDeepCurryChain = (ctx: RuleContext) => {
  const nodes = collectAllNodes(ctx.sourceFile)(ctx.sourceFile);
  return RA.chain(checkNodeCurryChain(ctx))(nodes);
};

export const detectDddAndArityHints = ((ctx: RuleContext): ReadonlyArray<AgentHint> => [
  ...checkLongFlows(ctx),
  ...checkMixedPureAndIo(ctx),
  ...checkMultiParamArityStrategy(ctx),
  ...checkDeepCurryChain(ctx),
]) satisfies HintRunner;
