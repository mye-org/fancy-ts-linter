import { constant, flow } from 'fp-ts/lib/function.js';
import * as B from 'fp-ts/lib/boolean.js';
import * as O from 'fp-ts/lib/Option.js';
import * as RA from 'fp-ts/lib/ReadonlyArray.js';
import type { ReadonlyNonEmptyArray } from 'fp-ts/lib/ReadonlyNonEmptyArray.js';
import * as ts from 'typescript';
import type { DiagnosticError, RuleContext } from '../model/report.js';

export type RuleRunner = (ctx: RuleContext) => ReadonlyArray<DiagnosticError>;

const pairSelf = <A>(a: A) => [a, a] as const;

const stepNodeQueueNonEmpty = (sf: ts.SourceFile) => (q: ReadonlyNonEmptyArray<ts.Node>) =>
  [q[0], [...q[0].getChildren(sf), ...q.slice(1)]] as const;

const stepNodeQueue = (sf: ts.SourceFile) =>
  flow(O.fromPredicate(RA.isNonEmpty<ts.Node>), O.map(stepNodeQueueNonEmpty(sf)));

const collectAllNodes = (sf: ts.SourceFile) => (node: ts.Node) =>
  RA.unfold([node] satisfies ReadonlyArray<ts.Node>, stepNodeQueue(sf));

type PfErrorInput = {
  readonly ruleId: string;
  readonly node: ts.Node;
  readonly message: string;
  readonly fixGuidance: string;
};

const makePfError =
  (ctx: RuleContext) =>
  ({ ruleId, node, message, fixGuidance }: PfErrorInput): DiagnosticError => ({
    ruleId,
    category: 'point-free',
    location: ctx.inspector.getLocation(ctx.sourceFile)(node),
    message,
    snippet: ctx.inspector.getSnippet(ctx.sourceFile)(node),
    fixGuidance,
  });

const isCurriedWrapperParent = (child: ts.Node) => (parent: ts.Node) =>
  ts.isSatisfiesExpression(parent) ||
  ts.isParenthesizedExpression(parent) ||
  (ts.isArrowFunction(parent) && parent.body === child);

const stepCurriedParent = (cur: ts.Node) => (p: ts.Node) =>
  [p, O.fromPredicate(isCurriedWrapperParent(cur))(p)] as const;

const expandCurriedParent = (cur: ts.Node) =>
  O.map(stepCurriedParent(cur))(O.fromNullable(cur.parent));

const stepCurriedAncestor = O.chain(expandCurriedParent);

const unfoldCurriedAncestors = (node: ts.Node) =>
  RA.unfold(O.some(node), stepCurriedAncestor);

const isTopLevelCurriedArrow = flow(
  unfoldCurriedAncestors,
  RA.last,
  O.exists(ts.isVariableDeclaration),
);

const isInlineLambdaNode = (n: ts.Node): n is ts.ArrowFunction | ts.FunctionExpression =>
  (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && !isTopLevelCurriedArrow(n);

const makeInlineLambdaError =
  (ctx: RuleContext) => (n: ts.ArrowFunction | ts.FunctionExpression) =>
    makePfError(ctx)({
      ruleId: 'no-inline-lambda',
      node: n,
      message:
        'Inline anonymous lambda is forbidden; extract to a named private unary function or use an Optic.',
      fixGuidance:
        'Extract this lambda into a named top-level `const fn = ...` or replace property access with a `monocle-ts` Optic.',
    });

const checkInlineLambdas = (ctx: RuleContext) =>
  flow(RA.filter(isInlineLambdaNode), RA.map(makeInlineLambdaError(ctx)));

const isNonUnaryArrow = (n: ts.Node): n is ts.ArrowFunction | ts.FunctionExpression =>
  (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && n.parameters.length !== 1;

const getArrowArityGuidance = (paramCount: number) =>
  B.match(
    constant(
      'Bundle parameters into a single named Domain/Input Record (`(input: FnInput) => ...`), or use at most a 2–3 level curry (`(config) => (input) => ...`) only when outer args are partially applied.',
    ),
    constant(
      'Replace 0-arg thunk with `constant(...)` or accept a single domain input parameter.',
    ),
  )(paramCount === 0);

const makeArrowArityError =
  (ctx: RuleContext) => (n: ts.ArrowFunction | ts.FunctionExpression) =>
    makePfError(ctx)({
      ruleId: 'unary-arity-only',
      node: n,
      message: `Function must have arity 1 (single parameter), found ${n.parameters.length} parameter(s).`,
      fixGuidance: getArrowArityGuidance(n.parameters.length),
    });

const checkArrowArity = (ctx: RuleContext) =>
  flow(RA.filter(isNonUnaryArrow), RA.map(makeArrowArityError(ctx)));

const getParenInner = (p: ts.ParenthesizedExpression) => p.expression;

const pairParenInner = flow(getParenInner, pairSelf);

const stepParen = flow(
  O.fromPredicate(ts.isParenthesizedExpression),
  O.map(pairParenInner),
);

const unfoldParens = (node: ts.Expression) => RA.unfold(node, stepParen);

const unwrapParens = (node: ts.Expression) =>
  O.getOrElse(constant(node))(RA.last(unfoldParens(node)));

const isExpressionBody = (b: ts.ConciseBody): b is ts.Expression => !ts.isBlock(b);

const stepCurryBody = (arrow: ts.ArrowFunction) =>
  flow(
    O.fromPredicate(isExpressionBody),
    O.map(unwrapParens),
    O.chain(O.fromPredicate(ts.isArrowFunction)),
    O.map(pairSelf),
  )(arrow.body);

const countCurryDepth = (arrow: ts.ArrowFunction) =>
  1 + RA.unfold(arrow, stepCurryBody).length;

const isCurriedChainRoot = (n: ts.Node): n is ts.ArrowFunction =>
  ts.isArrowFunction(n) &&
  isTopLevelCurriedArrow(n) &&
  !(n.parent !== undefined && ts.isArrowFunction(n.parent));

const isDeepCurriedRoot = (n: ts.Node): n is ts.ArrowFunction =>
  isCurriedChainRoot(n) && countCurryDepth(n) > 3;

const makeCurryDepthError = (ctx: RuleContext) => (n: ts.ArrowFunction) =>
  makePfError(ctx)({
    ruleId: 'max-curry-depth',
    node: n,
    message: `Curried chain of depth ${countCurryDepth(n)} exceeds the maximum allowed depth of 3.`,
    fixGuidance:
      'Collapse parameters into a single named input record (`(input: FnInput) => ...`), or keep at most 2–3 curried levels (`(ctx) => (input: FnInput) => ...`) when outer arguments are reused via partial application.',
  });

const checkCurryDepth = (ctx: RuleContext) =>
  flow(RA.filter(isDeepCurriedRoot), RA.map(makeCurryDepthError(ctx)));

const isExemptBuilderProp = (pa: ts.PropertyAccessExpression) =>
  pa.name.text === 'with' || pa.name.text === 'when';

const isExternalDeclaration = (d: ts.Declaration) =>
  d.getSourceFile().fileName.includes('node_modules') ||
  d.getSourceFile().isDeclarationFile;

const isExternalSymbol = (sym: ts.Symbol) =>
  O.exists(isExternalDeclaration)(O.chain(RA.head)(O.fromNullable(sym.declarations)));

const isExemptMultiArgCallee = (ctx: RuleContext) => (call: ts.CallExpression) =>
  ctx.inspector.isFlowCall(call) ||
  O.exists(isExemptBuilderProp)(
    O.fromPredicate(ts.isPropertyAccessExpression)(call.expression),
  ) ||
  O.exists(isExternalSymbol)(
    O.fromNullable(ctx.checker.getSymbolAtLocation(call.expression)),
  );

const isDisallowedMultiArgCall =
  (ctx: RuleContext) => (n: ts.Node): n is ts.CallExpression =>
    ts.isCallExpression(n) && n.arguments.length > 1 && !isExemptMultiArgCallee(ctx)(n);

const makeCallArityError = (ctx: RuleContext) => (n: ts.CallExpression) =>
  makePfError(ctx)({
    ruleId: 'unary-arity-only',
    node: n,
    message: `Multi-argument call (${n.arguments.length} args) violates unary-arity rule.`,
    fixGuidance:
      'Refactor the target function to take a single named Input/Domain Record (`f({ ... })`), or at most a 2-level curry (`f(config)(input)`) if partially applied.',
  });

const checkCallArity = (ctx: RuleContext) =>
  flow(RA.filter(isDisallowedMultiArgCall(ctx)), RA.map(makeCallArityError(ctx)));

const isIdentifierNamed = (name: string) => (n: ts.Node) =>
  ts.isIdentifier(n) && n.text === name;

const referencesIdentifier = ({
  sf,
  name,
  node,
}: {
  readonly sf: ts.SourceFile;
  readonly name: string;
  readonly node: ts.Node;
}) => RA.some(isIdentifierNamed(name))(collectAllNodes(sf)(node));

const hasSingleParam = (a: ts.ArrowFunction) => a.parameters.length === 1;
const getParameters = (a: ts.ArrowFunction) => a.parameters;
const getParamNameNode = (p: ts.ParameterDeclaration) => p.name;
const getIdentifierText = (id: ts.Identifier) => id.text;
const getArrowBody = (a: ts.ArrowFunction) => a.body;
const isSingleArgCall = (c: ts.CallExpression) => c.arguments.length === 1;

const getEtaParamName = flow(
  O.fromPredicate(hasSingleParam),
  O.map(getParameters),
  O.chain(RA.head),
  O.map(getParamNameNode),
  O.chain(O.fromPredicate(ts.isIdentifier)),
  O.map(getIdentifierText),
);

const getSingleArgCall = flow(
  getArrowBody,
  O.fromPredicate(isExpressionBody),
  O.map(unwrapParens),
  O.chain(O.fromPredicate(ts.isCallExpression)),
  O.chain(O.fromPredicate(isSingleArgCall)),
);

const isMatchingEtaArg = (paramName: string) => (arg: ts.Expression) =>
  ts.isIdentifier(arg) && arg.text === paramName;

const isEtaCallForParam =
  ({ sf, paramName }: { readonly sf: ts.SourceFile; readonly paramName: string }) =>
  (body: ts.CallExpression) =>
    O.exists(isMatchingEtaArg(paramName))(RA.head(body.arguments)) &&
    !referencesIdentifier({ sf, name: paramName, node: body.expression });

const checkEtaWithParam =
  ({ sf, arrow }: { readonly sf: ts.SourceFile; readonly arrow: ts.ArrowFunction }) =>
  (paramName: string) =>
    O.exists(isEtaCallForParam({ sf, paramName }))(getSingleArgCall(arrow));

const isEtaReducibleArrow = (sf: ts.SourceFile) => (arrow: ts.ArrowFunction) =>
  O.exists(checkEtaWithParam({ sf, arrow }))(getEtaParamName(arrow));

const isEtaArrowNode = (sf: ts.SourceFile) => (n: ts.Node): n is ts.ArrowFunction =>
  ts.isArrowFunction(n) && isEtaReducibleArrow(sf)(n);

const makeEtaError = (ctx: RuleContext) => (n: ts.ArrowFunction) =>
  makePfError(ctx)({
    ruleId: 'no-eta-reducible',
    node: n,
    message: 'Eta-reducible wrapper `x => f(x)` violates point-free style.',
    fixGuidance: 'Use the function `f` directly without the lambda wrapper.',
  });

const checkEtaReducible = (ctx: RuleContext) =>
  flow(RA.filter(isEtaArrowNode(ctx.sourceFile)), RA.map(makeEtaError(ctx)));

const applyPointFreeChecks =
  (ctx: RuleContext) => (nodes: ReadonlyArray<ts.Node>) => [
    ...checkInlineLambdas(ctx)(nodes),
    ...checkArrowArity(ctx)(nodes),
    ...checkCurryDepth(ctx)(nodes),
    ...checkCallArity(ctx)(nodes),
    ...checkEtaReducible(ctx)(nodes),
  ];

const runPointFreeChecks = (ctx: RuleContext) =>
  applyPointFreeChecks(ctx)(collectAllNodes(ctx.sourceFile)(ctx.sourceFile));

const identityCtx = (ctx: RuleContext) => ctx;

export const checkPointFreeRules = flow(
  identityCtx,
  runPointFreeChecks,
) satisfies RuleRunner;
