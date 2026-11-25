import * as O from 'fp-ts/lib/Option.js';
import * as RA from 'fp-ts/lib/ReadonlyArray.js';
import * as ts from 'typescript';
import type { AgentHint, BindingInfo, RuleContext } from '../model/report.js';

export type HintRunner = (ctx: RuleContext) => ReadonlyArray<AgentHint>;

const collectAllNodes = (sf: ts.SourceFile) => (node: ts.Node): ReadonlyArray<ts.Node> => [
  node,
  ...RA.chain(collectAllNodes(sf))(node.getChildren(sf)),
];

const checkLongFlows = (ctx: RuleContext): ReadonlyArray<AgentHint> =>
  RA.chain((b: BindingInfo): ReadonlyArray<AgentHint> =>
    O.match(
      () => [] as ReadonlyArray<AgentHint>,
      (steps: number): ReadonlyArray<AgentHint> =>
        steps > ctx.options.maxFlowSteps
          ? [
              {
                hintId: `ddd-flow-length-${b.name}`,
                category: 'ddd-decomposition',
                priority: 'high',
                location: { line: b.location.line, column: b.location.column },
                evidence: `Pipeline \`${b.name}\` has ${steps} steps (threshold: ${ctx.options.maxFlowSteps}).`,
                suggestion:
                  'Decompose this long `flow(...)` into 2–4 domain-meaningful sub-flows (`const validateOrder = flow(...)`, `const applyPricing = flow(...)`, `export const main = flow(validateOrder, applyPricing)`).',
                suggestedSignature: O.none,
                researchQuestions: [
                  'Which contiguous steps form a cohesive DDD phase (Validation, Domain Transform, Persistence/I/O)?',
                ],
              },
            ]
          : [],
    )(b.stepCount),
  )(ctx.ir.bindings);

const checkMixedPureAndIo = (ctx: RuleContext): ReadonlyArray<AgentHint> => {
  const hasPure = RA.some((b: BindingInfo) => b.effects.includes('Pure'))(ctx.ir.bindings);
  const hasAsyncEffect = RA.some(
    (b: BindingInfo) =>
      b.effects.includes('TaskEither') ||
      b.effects.includes('ReaderTaskEither') ||
      b.effects.includes('Task'),
  )(ctx.ir.bindings);

  const exportedFlow = RA.findFirst((b: BindingInfo) => b.kind === 'exported-flow')(
    ctx.ir.bindings,
  );

  return hasPure && hasAsyncEffect && O.isSome(exportedFlow) && (exportedFlow.value.stepCount._tag === 'Some' && exportedFlow.value.stepCount.value >= 6)
    ? [
        {
          hintId: 'ddd-pure-core-io-shell',
          category: 'ddd-decomposition',
          priority: 'medium',
          location: {
            line: exportedFlow.value.location.line,
            column: exportedFlow.value.location.column,
          },
          evidence: `\`${exportedFlow.value.name}\` orchestrates both pure domain logic and async I/O (\`TaskEither\`/\`ReaderTaskEither\`) in one flat pipeline.`,
          suggestion:
            'Group pure domain steps into a synchronous sub-flow (`Either` / `Option`) and keep async I/O steps in a separate shell sub-flow.',
          suggestedSignature: O.none,
          researchQuestions: [
            'Can all pure business rules be tested independently as a pure `Either` sub-flow?',
          ],
        },
      ]
    : [];
};

const isFunctionLikeParam = (checker: ts.TypeChecker) => (p: ts.ParameterDeclaration): boolean =>
  checker.getTypeAtLocation(p).getCallSignatures().length > 0;

const checkMultiParamArityStrategy = (ctx: RuleContext): ReadonlyArray<AgentHint> => {
  const nodes = collectAllNodes(ctx.sourceFile)(ctx.sourceFile);
  return RA.chain((n: ts.Node): ReadonlyArray<AgentHint> => {
    if (!ts.isArrowFunction(n) || n.parameters.length <= 1) {
      return [];
    }
    const hasFnOrConfig = RA.some(
      (p: ts.ParameterDeclaration) =>
        isFunctionLikeParam(ctx.checker)(p) ||
        /config|env|deps|predicate|fn|rate|factor|threshold/i.test(p.name.getText(ctx.sourceFile)),
    )(n.parameters);

    const loc = ctx.inspector.getLocation(ctx.sourceFile)(n);
    return [
      {
        hintId: `arity-strategy-${loc.line}-${loc.column}`,
        category: 'arity-strategy',
        priority: 'high',
        location: { line: loc.line, column: loc.column },
        evidence: `Function at line ${loc.line} has ${n.parameters.length} parameters.`,
        suggestion: hasFnOrConfig
          ? 'Keep currying to **at most 2–3 levels** (`(configOrContext) => (input: InputRecord) => result`) and only when outer args are partially applied; otherwise use a single named **Domain/Input Record**.'
          : 'Bundle cohesive peer parameters into a single named **Domain Record** type (`export type Input = { ... }`).',
        suggestedSignature: O.none,
        researchQuestions: [
          'Are these parameters configuration/behavior reused across calls (2-step curry) or peer fields of one call (Domain Record)?',
        ],
      },
    ];
  })(nodes);
};

const unwrapParens = (node: ts.Expression): ts.Expression =>
  ts.isParenthesizedExpression(node) ? unwrapParens(node.expression) : node;

const countCurryDepth = (arrow: ts.ArrowFunction): number => {
  if (ts.isBlock(arrow.body)) {
    return 1;
  }
  const body = unwrapParens(arrow.body);
  return ts.isArrowFunction(body) ? 1 + countCurryDepth(body) : 1;
};

const isCurriedRoot = (n: ts.Node): n is ts.ArrowFunction =>
  ts.isArrowFunction(n) && !(n.parent !== undefined && ts.isArrowFunction(n.parent));

const checkDeepCurryChain = (ctx: RuleContext): ReadonlyArray<AgentHint> => {
  const nodes = collectAllNodes(ctx.sourceFile)(ctx.sourceFile);
  return RA.chain((n: ts.Node): ReadonlyArray<AgentHint> => {
    if (!isCurriedRoot(n)) {
      return [];
    }
    const depth = countCurryDepth(n);
    if (depth < 3) {
      return [];
    }
    const loc = ctx.inspector.getLocation(ctx.sourceFile)(n);
    return [
      {
        hintId: `arity-curry-depth-${loc.line}-${loc.column}`,
        category: 'arity-strategy',
        priority: depth >= 4 ? 'high' : 'medium',
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
  })(nodes);
};

export const detectDddAndArityHints = ((ctx: RuleContext): ReadonlyArray<AgentHint> => [
  ...checkLongFlows(ctx),
  ...checkMixedPureAndIo(ctx),
  ...checkMultiParamArityStrategy(ctx),
  ...checkDeepCurryChain(ctx),
]) satisfies HintRunner;
