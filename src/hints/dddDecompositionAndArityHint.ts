import * as B from 'fp-ts/lib/boolean.js';
import { constant, flow } from 'fp-ts/lib/function.js';
import * as O from 'fp-ts/lib/Option.js';
import * as RA from 'fp-ts/lib/ReadonlyArray.js';
import * as RNEA from 'fp-ts/lib/ReadonlyNonEmptyArray.js';
import * as ts from 'typescript';
import type { AgentHint, BindingInfo, RuleContext } from '../model/report.js';

export type HintRunner = (ctx: RuleContext) => ReadonlyArray<AgentHint>;

type FlowHintInput = {
  readonly b: BindingInfo;
  readonly steps: number;
  readonly maxFlowSteps: number;
};

type FlowCheckContext = {
  readonly ctx: RuleContext;
  readonly b: BindingInfo;
};

type ArityLocInput = {
  readonly ctx: RuleContext;
  readonly arrow: ts.ArrowFunction;
};

type CurryHintInput = {
  readonly ctx: RuleContext;
  readonly arrow: ts.ArrowFunction;
  readonly depth: number;
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

const buildLongFlowHint = (input: FlowHintInput) => [
  {
    hintId: `ddd-flow-length-${input.b.name}`,
    category: 'ddd-decomposition' as const,
    priority: 'high' as const,
    location: { line: input.b.location.line, column: input.b.location.column },
    evidence: `Pipeline \`${input.b.name}\` has ${input.steps} steps (threshold: ${input.maxFlowSteps}).`,
    suggestion:
      'Decompose this long `flow(...)` into 2–4 domain-meaningful sub-flows (`const validateOrder = flow(...)`, `const applyPricing = flow(...)`, `export const main = flow(validateOrder, applyPricing)`).',
    suggestedSignature: O.none,
    researchQuestions: [
      'Which contiguous steps form a cohesive DDD phase (Validation, Domain Transform, Persistence/I/O)?',
    ],
  },
];

const checkFlowSteps =
  (input: FlowCheckContext) =>
  (steps: number) =>
    B.match(
      constant(RA.zero<AgentHint>()),
      constant(
        buildLongFlowHint({
          b: input.b,
          steps,
          maxFlowSteps: input.ctx.options.maxFlowSteps,
        }),
      ),
    )(steps > input.ctx.options.maxFlowSteps);

const checkBindingFlowLength =
  (ctx: RuleContext) =>
  (b: BindingInfo) =>
    O.match(constant(RA.zero<AgentHint>()), checkFlowSteps({ ctx, b }))(b.stepCount);

const checkLongFlows = (ctx: RuleContext) =>
  RA.chain(checkBindingFlowLength(ctx))(ctx.ir.bindings);

const hasPureEffect = (b: BindingInfo) => b.effects.includes('Pure');

const hasAsyncEffectKind = (b: BindingInfo) =>
  b.effects.includes('TaskEither') ||
  b.effects.includes('ReaderTaskEither') ||
  b.effects.includes('Task');

const isExportedFlow = (b: BindingInfo) => b.kind === 'exported-flow';

const isAtLeastSix = (n: number) => n >= 6;

const hasAtLeastSixSteps = (b: BindingInfo) => O.exists(isAtLeastSix)(b.stepCount);

const buildPureCoreIoShellHint = (b: BindingInfo) => [
  {
    hintId: 'ddd-pure-core-io-shell',
    category: 'ddd-decomposition' as const,
    priority: 'medium' as const,
    location: { line: b.location.line, column: b.location.column },
    evidence: `\`${b.name}\` orchestrates both pure domain logic and async I/O (\`TaskEither\`/\`ReaderTaskEither\`) in one flat pipeline.`,
    suggestion:
      'Group pure domain steps into a synchronous sub-flow (`Either` / `Option`) and keep async I/O steps in a separate shell sub-flow.',
    suggestedSignature: O.none,
    researchQuestions: [
      'Can all pure business rules be tested independently as a pure `Either` sub-flow?',
    ],
  },
];

const checkMixedPureAndIo = (ctx: RuleContext) =>
  flow(
    RA.findFirst(isExportedFlow),
    O.filter(hasAtLeastSixSteps),
    O.filter(
      constant(
        RA.some(hasPureEffect)(ctx.ir.bindings) &&
          RA.some(hasAsyncEffectKind)(ctx.ir.bindings),
      ),
    ),
    O.match(constant(RA.zero<AgentHint>()), buildPureCoreIoShellHint),
  )(ctx.ir.bindings);

const isFunctionLikeParam = (checker: ts.TypeChecker) => (p: ts.ParameterDeclaration) =>
  checker.getTypeAtLocation(p).getCallSignatures().length > 0;

const isConfigOrFnParam =
  (ctx: RuleContext) =>
  (p: ts.ParameterDeclaration) =>
    isFunctionLikeParam(ctx.checker)(p) ||
    /config|env|deps|predicate|fn|rate|factor|threshold/i.test(p.name.getText(ctx.sourceFile));

const isMultiParamArrow = (n: ts.Node): n is ts.ArrowFunction =>
  ts.isArrowFunction(n) && n.parameters.length > 1;

const buildArityHintWithLoc =
  (input: ArityLocInput) =>
  (loc: { readonly line: number; readonly column: number }): ReadonlyArray<AgentHint> => [
    {
      hintId: `arity-strategy-${loc.line}-${loc.column}`,
      category: 'arity-strategy',
      priority: 'high',
      location: { line: loc.line, column: loc.column },
      evidence: `Function at line ${loc.line} has ${input.arrow.parameters.length} parameters.`,
      suggestion: B.match(
        constant(
          'Bundle cohesive peer parameters into a single named **Domain Record** type (`export type Input = { ... }`).',
        ),
        constant(
          'Keep currying to **at most 2–3 levels** (`(configOrContext) => (input: InputRecord) => result`) and only when outer args are partially applied; otherwise use a single named **Domain/Input Record**.',
        ),
      )(RA.some(isConfigOrFnParam(input.ctx))(input.arrow.parameters)),
      suggestedSignature: O.none,
      researchQuestions: [
        'Are these parameters configuration/behavior reused across calls (2-step curry) or peer fields of one call (Domain Record)?',
      ],
    },
  ];

const buildArityStrategyHint =
  (ctx: RuleContext) =>
  (arrow: ts.ArrowFunction) =>
    buildArityHintWithLoc({ ctx, arrow })(ctx.inspector.getLocation(ctx.sourceFile)(arrow));

const checkNodeArity = (ctx: RuleContext) =>
  flow(
    O.fromPredicate(isMultiParamArrow),
    O.match(constant(RA.zero<AgentHint>()), buildArityStrategyHint(ctx)),
  );

const checkMultiParamArityStrategy = (ctx: RuleContext) =>
  RA.chain(checkNodeArity(ctx))(collectAllNodes(ctx.sourceFile)(ctx.sourceFile));

const pairInnerParen = (p: ts.ParenthesizedExpression) =>
  [p.expression, p.expression] as const;

const stepParenExpr = flow(
  O.fromPredicate(ts.isParenthesizedExpression),
  O.map(pairInnerParen),
);

const unwrapParens = (node: ts.Expression) =>
  flow(RA.last<ts.Expression>, O.getOrElse(constant(node)))(RA.unfold(node, stepParenExpr));

const pairNextArrow = (next: ts.ArrowFunction) => [next, next] as const;

const getBodyNode = (arrow: ts.ArrowFunction) => arrow.body;

const getArrowBodyExpr = flow(
  getBodyNode,
  O.fromPredicate(ts.isExpression),
  O.map(unwrapParens),
  O.filter(ts.isArrowFunction),
);

const stepCurryArrow = flow(getArrowBodyExpr, O.map(pairNextArrow));

const countCurryDepth = (arrow: ts.ArrowFunction) =>
  1 + RA.unfold(arrow, stepCurryArrow).length;

const isCurriedRoot = (n: ts.Node): n is ts.ArrowFunction =>
  ts.isArrowFunction(n) && !(n.parent !== undefined && ts.isArrowFunction(n.parent));

const isDepthAtLeastThree = (depth: number) => depth >= 3;

const buildCurryHintWithLoc =
  (input: CurryHintInput) =>
  (loc: { readonly line: number; readonly column: number }): ReadonlyArray<AgentHint> => [
    {
      hintId: `arity-curry-depth-${loc.line}-${loc.column}`,
      category: 'arity-strategy',
      priority: B.match(constant('medium' as const), constant('high' as const))(input.depth >= 4),
      location: { line: loc.line, column: loc.column },
      evidence: `Curried function at line ${loc.line} has ${input.depth} nested parameter levels.`,
      suggestion:
        'Avoid long curried chains (positional ambiguity, closure & type-checking overhead). Collapse parameters into a single named input object (`(input: FnInput) => ...`), or use a 2-step curry (`(ctx) => (input: FnInput) => ...`) only if the outer argument is partially applied.',
      suggestedSignature: O.none,
      researchQuestions: [
        'Are all arguments supplied at once at call sites (use a single input record), or is the outer argument genuinely reused via partial application (2-step curry)?',
      ],
    },
  ];

const buildDeepCurryHint =
  (input: ArityLocInput) =>
  (depth: number) =>
    buildCurryHintWithLoc({ ctx: input.ctx, arrow: input.arrow, depth })(
      input.ctx.inspector.getLocation(input.ctx.sourceFile)(input.arrow),
    );

const checkArrowCurryDepth =
  (ctx: RuleContext) =>
  (arrow: ts.ArrowFunction) =>
    flow(
      countCurryDepth,
      O.fromPredicate(isDepthAtLeastThree),
      O.match(constant(RA.zero<AgentHint>()), buildDeepCurryHint({ ctx, arrow })),
    )(arrow);

const checkNodeCurryDepth = (ctx: RuleContext) =>
  flow(
    O.fromPredicate(isCurriedRoot),
    O.match(constant(RA.zero<AgentHint>()), checkArrowCurryDepth(ctx)),
  );

const checkDeepCurryChain = (ctx: RuleContext) =>
  RA.chain(checkNodeCurryDepth(ctx))(collectAllNodes(ctx.sourceFile)(ctx.sourceFile));

const runDddAndArityHints = (ctx: RuleContext) => [
  ...checkLongFlows(ctx),
  ...checkMixedPureAndIo(ctx),
  ...checkMultiParamArityStrategy(ctx),
  ...checkDeepCurryChain(ctx),
];

const identityCtx = (ctx: RuleContext) => ctx;

export const detectDddAndArityHints = flow(
  identityCtx,
  runDddAndArityHints,
) satisfies HintRunner;
