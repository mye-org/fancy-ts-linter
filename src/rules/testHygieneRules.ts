import * as B from 'fp-ts/lib/boolean.js';
import * as Eq from 'fp-ts/lib/Eq.js';
import { constant, flow, identity } from 'fp-ts/lib/function.js';
import * as N from 'fp-ts/lib/number.js';
import * as O from 'fp-ts/lib/Option.js';
import * as RA from 'fp-ts/lib/ReadonlyArray.js';
import * as S from 'fp-ts/lib/string.js';
import { iso } from 'newtype-ts';
import * as ts from 'typescript';
import type {
  ColumnNumber,
  DiagnosticError,
  DiagnosticMessage,
  FixGuidance,
  LineNumber,
  RuleContext,
  RuleId,
} from '../model/report.js';

export type RuleRunner = (ctx: RuleContext) => ReadonlyArray<DiagnosticError>;

const isoRuleId = iso<RuleId>();
const isoDiagMsg = iso<DiagnosticMessage>();
const isoFixGuidance = iso<FixGuidance>();
const isoLine = iso<LineNumber>();
const isoCol = iso<ColumnNumber>();

const expandHeadNode =
  ({ sf, queue }: { readonly sf: ts.SourceFile; readonly queue: ReadonlyArray<ts.Node> }) =>
  (head: ts.Node): readonly [ts.Node, ReadonlyArray<ts.Node>] => [
    head,
    [...head.getChildren(sf), ...RA.dropLeft(1)(queue)],
  ];

const stepNodeQueue = (sf: ts.SourceFile) => (queue: ReadonlyArray<ts.Node>) =>
  O.map(expandHeadNode({ sf, queue }))(RA.head(queue));

const collectNodes = (sf: ts.SourceFile) => (root: ts.Node): ReadonlyArray<ts.Node> =>
  RA.unfold(RA.of<ts.Node>(root), stepNodeQueue(sf));

type TestErrorInput = {
  readonly ruleId: string;
  readonly category: DiagnosticError['category'];
  readonly node: ts.Node;
  readonly message: string;
  readonly fixGuidance: string;
};

const makeTestError =
  (ctx: RuleContext) =>
  ({ ruleId, category, node, message, fixGuidance }: TestErrorInput): DiagnosticError => ({
    ruleId: isoRuleId.wrap(ruleId),
    category,
    location: ctx.inspector.getLocation(ctx.sourceFile)(node),
    message: isoDiagMsg.wrap(message),
    snippet: ctx.inspector.getSnippet(ctx.sourceFile)(node),
    fixGuidance: isoFixGuidance.wrap(fixGuidance),
  });

const isConstAsExpr = (sf: ts.SourceFile) => (n: ts.AsExpression) =>
  n.type.getText(sf).trim() === 'const';

const isAnyKeyword = (n: ts.Node) => n.kind === ts.SyntaxKind.AnyKeyword;

const isDisallowedAsExpr = (sf: ts.SourceFile) => (n: ts.Node) =>
  ts.isAsExpression(n) && !isConstAsExpr(sf)(n);

const isTypeHoleNode = (sf: ts.SourceFile) => (n: ts.Node) =>
  isAnyKeyword(n) ||
  isDisallowedAsExpr(sf)(n) ||
  ts.isTypeAssertionExpression(n) ||
  ts.isNonNullExpression(n);

const toTypeHoleError = (ctx: RuleContext) => (n: ts.Node) =>
  makeTestError(ctx)({
    ruleId: 'test-no-type-holes',
    category: 'type-safety',
    node: n,
    message: 'Type holes (`any`, `as` casts, `<T>x`, `!`) are forbidden in test files.',
    fixGuidance:
      'Construct strongly-typed test fixtures or use `satisfies` / smart constructors instead of type assertions.',
  });

const checkTestNoTypeHoles = (ctx: RuleContext) =>
  flow(RA.filter(isTypeHoleNode(ctx.sourceFile)), RA.map(toTypeHoleError(ctx)));

const getIdentifierText = (n: ts.Identifier) => n.text;

const formatIdentAndMember = (propName: string) => (id: ts.Identifier) =>
  `${id.text}.${propName}`;

const formatPropertyAccess = (pa: ts.PropertyAccessExpression): O.Option<string> =>
  O.map(formatIdentAndMember(pa.name.text))(O.fromPredicate(ts.isIdentifier)(pa.expression));

const getInnerParenExpr = (p: ts.ParenthesizedExpression): ts.Expression => unwrapParenExpr(p.expression);

const unwrapParenExpr = (expr: ts.Expression): ts.Expression =>
  O.match(constant(expr), getInnerParenExpr)(O.fromPredicate(ts.isParenthesizedExpression)(expr));

const getCalleeName = (expr: ts.LeftHandSideExpression): O.Option<string> => {
  const unwrapped = unwrapParenExpr(expr);
  const identOpt = O.map(getIdentifierText)(O.fromPredicate(ts.isIdentifier)(unwrapped));
  return O.match(
    () => O.chain(formatPropertyAccess)(O.fromPredicate(ts.isPropertyAccessExpression)(unwrapped)),
    O.some<string>,
  )(identOpt);
};

const isTestCaseName = (name: string) => {
  const callees: ReadonlyArray<string> = [
    'it',
    'test',
    'it.only',
    'test.only',
    'it.concurrent',
    'test.concurrent',
  ];
  return RA.elem(S.Eq)(name)(callees);
};

const isTestCaseCall = (n: ts.Node): n is ts.CallExpression =>
  ts.isCallExpression(n) && O.exists(isTestCaseName)(getCalleeName(n.expression));

const isFunctionCallback = (n: ts.Node): n is ts.ArrowFunction | ts.FunctionExpression =>
  ts.isArrowFunction(n) || ts.isFunctionExpression(n);

const getTestCallback = (
  call: ts.CallExpression,
): O.Option<ts.ArrowFunction | ts.FunctionExpression> =>
  RA.findFirst(isFunctionCallback)(call.arguments);

const isBranchingNode = (n: ts.Node) =>
  ts.isIfStatement(n) ||
  ts.isSwitchStatement(n) ||
  ts.isForStatement(n) ||
  ts.isForInStatement(n) ||
  ts.isForOfStatement(n) ||
  ts.isWhileStatement(n) ||
  ts.isDoStatement(n) ||
  ts.isConditionalExpression(n) ||
  ts.isTryStatement(n);

const toBranchingError = (ctx: RuleContext) => (n: ts.Node) =>
  makeTestError(ctx)({
    ruleId: 'test-no-branching',
    category: 'test-hygiene',
    node: n,
    message:
      'Control-flow branching (`if`, `switch`, loops, ternary, `try/catch`) is forbidden inside tests.',
    fixGuidance:
      'Keep each test flat (Arrange-Act-Assert). Split conditional paths into separate `it(...)` cases.',
  });

const collectBranchingInTest =
  (ctx: RuleContext) => (cb: ts.ArrowFunction | ts.FunctionExpression) =>
    RA.map(toBranchingError(ctx))(
      RA.filter(isBranchingNode)(collectNodes(ctx.sourceFile)(cb.body)),
    );

const checkTestCallBranching = (ctx: RuleContext) => (call: ts.CallExpression) =>
  O.match(
    constant(RA.zero<DiagnosticError>()),
    collectBranchingInTest(ctx),
  )(getTestCallback(call));

const checkTestNoBranching = (ctx: RuleContext) =>
  flow(RA.filter(isTestCaseCall), RA.chain(checkTestCallBranching(ctx)));

const isDescribeName = (name: string) => {
  const callees: ReadonlyArray<string> = ['describe', 'describe.only', 'describe.skip'];
  return RA.elem(S.Eq)(name)(callees);
};

const isCallWithDescribeName = (call: ts.CallExpression) =>
  O.exists(isDescribeName)(getCalleeName(call.expression));

const isDescribeCallback = (fn: ts.Node) =>
  O.exists(isCallWithDescribeName)(
    O.chain(O.fromPredicate(ts.isCallExpression))(O.fromNullable(fn.parent)),
  );

const classifyScopeNode = (cur: ts.Node): O.Option<boolean> =>
  B.match(
    () =>
      B.match(
        () =>
          B.match(
            constant(O.none),
            constant(O.some(false)),
          )(ts.isFunctionDeclaration(cur) || ts.isMethodDeclaration(cur)),
        () => O.some(isDescribeCallback(cur)),
      )(isFunctionCallback(cur)),
    constant(O.some(true)),
  )(ts.isSourceFile(cur));

const stepScopeToParent = (cur: ts.Node) =>
  O.match(constant(false), walkParentScope)(O.fromNullable(cur.parent));

const walkParentScope = (cur: ts.Node): boolean =>
  O.match(() => stepScopeToParent(cur), identity<boolean>)(classifyScopeNode(cur));

const isAtSharedSuiteScope = (node: ts.Node) =>
  O.match(constant(false), walkParentScope)(O.fromNullable(node.parent));

const isMutableVarDeclList = (n: ts.Node): n is ts.VariableDeclarationList =>
  ts.isVariableDeclarationList(n) && (n.flags & ts.NodeFlags.Const) === 0;

const isSharedMutableDecl = (n: ts.Node) =>
  isMutableVarDeclList(n) && isAtSharedSuiteScope(n);

const toSharedMutableError = (ctx: RuleContext) => (n: ts.Node) =>
  makeTestError(ctx)({
    ruleId: 'test-no-shared-mutable-state',
    category: 'test-hygiene',
    node: n,
    message: 'Shared mutable `let`/`var` state at file or `describe` scope is forbidden.',
    fixGuidance:
      'Construct fresh fixtures inside each `it(...)` block or via pure factory functions so tests remain isolated.',
  });

const checkSharedMutableState = (ctx: RuleContext) =>
  flow(RA.filter(isSharedMutableDecl), RA.map(toSharedMutableError(ctx)));

const isZeroArgNewDate = (n: ts.Node) =>
  ts.isNewExpression(n) &&
  ts.isIdentifier(n.expression) &&
  n.expression.text === 'Date' &&
  (n.arguments === undefined || n.arguments.length === 0);

const isNondeterministicPropName = (name: string) => {
  const props: ReadonlyArray<string> = ['Date.now', 'Math.random'];
  return RA.elem(S.Eq)(name)(props);
};

const isFsSyncCall = (expr: ts.LeftHandSideExpression) =>
  ts.isPropertyAccessExpression(expr) &&
  ts.isIdentifier(expr.expression) &&
  expr.expression.text === 'fs' &&
  expr.name.text.endsWith('Sync');

const isFetchCall = (expr: ts.LeftHandSideExpression) =>
  ts.isIdentifier(expr) && expr.text === 'fetch';

const isNondeterministicCall = (n: ts.Node) =>
  ts.isCallExpression(n) &&
  (O.exists(isNondeterministicPropName)(getCalleeName(n.expression)) ||
    isFetchCall(n.expression) ||
    isFsSyncCall(n.expression));

const isNondeterministicNode = (n: ts.Node) =>
  isZeroArgNewDate(n) || isNondeterministicCall(n);

const toNondeterminismError = (ctx: RuleContext) => (n: ts.Node) =>
  makeTestError(ctx)({
    ruleId: 'test-no-nondeterminism',
    category: 'test-hygiene',
    node: n,
    message:
      'Non-deterministic or I/O call (`Date.now()`, `new Date()`, `Math.random()`, `fetch`, `fs.*Sync`) in unit test.',
    fixGuidance:
      'Pass deterministic timestamps/inputs or inject clock/I/O dependencies via `Reader`/`TaskEither` ports.',
  });

const checkNondeterminism = (ctx: RuleContext) =>
  flow(RA.filter(isNondeterministicNode), RA.map(toNondeterminismError(ctx)));

const isAssertionRoot = (root: string) => {
  const roots: ReadonlyArray<string> = ['expect', 'assert', 'expectTypeOf', 'should'];
  return RA.elem(S.Eq)(root)(roots);
};

const isAssertionName = (name: string) =>
  O.exists(isAssertionRoot)(RA.head(name.split('.')));

const isAssertionCall = (n: ts.Node) =>
  ts.isCallExpression(n) && O.exists(isAssertionName)(getCalleeName(n.expression));

const hasNoAssertions =
  (sf: ts.SourceFile) => (cb: ts.ArrowFunction | ts.FunctionExpression) =>
    (ts.isBlock(cb.body) && cb.body.statements.length === 0) ||
    !RA.exists(isAssertionCall)(collectNodes(sf)(cb.body));

const toAssertionlessError = (ctx: RuleContext) => (call: ts.CallExpression) =>
  makeTestError(ctx)({
    ruleId: 'test-no-assertionless-test',
    category: 'test-hygiene',
    node: call,
    message: 'Test case has no assertions (`expect`/`assert`) or an empty body.',
    fixGuidance: 'Assert the expected output or state transition, or remove the dead test case.',
  });

const isAssertionlessTestCall = (sf: ts.SourceFile) => (call: ts.CallExpression) =>
  O.exists(hasNoAssertions(sf))(getTestCallback(call));

const checkAssertionlessTests = (ctx: RuleContext) =>
  flow(
    RA.filter(isTestCaseCall),
    RA.filter(isAssertionlessTestCall(ctx.sourceFile)),
    RA.map(toAssertionlessError(ctx)),
  );

const diagnosticErrorKey = (e: DiagnosticError) => ({
  ruleId: isoRuleId.unwrap(e.ruleId),
  line: isoLine.unwrap(e.location.line),
  column: isoCol.unwrap(e.location.column),
  message: isoDiagMsg.unwrap(e.message),
});

const diagnosticErrorEq = Eq.contramap(diagnosticErrorKey)(
  Eq.struct({
    ruleId: S.Eq,
    line: N.Eq,
    column: N.Eq,
    message: S.Eq,
  }),
);

export const checkTestHygieneRules = ((ctx) => {
  const nodes = collectNodes(ctx.sourceFile)(ctx.sourceFile);
  const combined = [
    ...ctx.tscErrors,
    ...checkTestNoTypeHoles(ctx)(nodes),
    ...checkTestNoBranching(ctx)(nodes),
    ...checkSharedMutableState(ctx)(nodes),
    ...checkNondeterminism(ctx)(nodes),
    ...checkAssertionlessTests(ctx)(nodes),
  ];
  return RA.uniq(diagnosticErrorEq)(combined);
}) satisfies RuleRunner;
