import { sequenceS } from 'fp-ts/lib/Apply.js';
import { flow } from 'fp-ts/lib/function.js';
import * as O from 'fp-ts/lib/Option.js';
import * as RA from 'fp-ts/lib/ReadonlyArray.js';
import * as S from 'fp-ts/lib/string.js';
import { Lens } from 'monocle-ts';
import * as ts from 'typescript';
import { SyntaxKind } from 'typescript';
import type { DiagnosticError, RuleContext } from '../model/report.js';

export type RuleRunner = (ctx: RuleContext) => ReadonlyArray<DiagnosticError>;

const sourceFileLens = Lens.fromPath<RuleContext>()(['sourceFile']);
const getLocationLens = Lens.fromPath<RuleContext>()(['inspector', 'getLocation']);
const getSnippetLens = Lens.fromPath<RuleContext>()(['inspector', 'getSnippet']);
const operatorKindLens = Lens.fromPath<ts.BinaryExpression>()(['operatorToken', 'kind']);
const propNameTextLens = Lens.fromPath<ts.PropertyAccessExpression>()(['name', 'text']);

const toNextQueue =
  (sf: ts.SourceFile) =>
  ({ head, tail }: { readonly head: ts.Node; readonly tail: ReadonlyArray<ts.Node> }) =>
    [head, [...head.getChildren(sf), ...tail]] as const;

const stepQueue = (sf: ts.SourceFile) => (queue: ReadonlyArray<ts.Node>) =>
  O.map(toNextQueue(sf))(sequenceS(O.Apply)({ head: RA.head(queue), tail: RA.tail(queue) }));

const collectAllNodes = (sf: ts.SourceFile) => (root: ts.Node) =>
  RA.unfold(RA.of(root), stepQueue(sf));

type PurityErrorInput = {
  readonly ruleId: string;
  readonly node: ts.Node;
  readonly message: string;
  readonly fixGuidance: string;
};

const makePurityError =
  (ctx: RuleContext) =>
  ({ ruleId, node, message, fixGuidance }: PurityErrorInput): DiagnosticError => ({
    ruleId,
    category: 'declarative-purity',
    location: getLocationLens.get(ctx)(sourceFileLens.get(ctx))(node),
    message,
    snippet: getSnippetLens.get(ctx)(sourceFileLens.get(ctx))(node),
    fixGuidance,
  });

const isBlockBodyFn = (n: ts.Node): n is ts.ArrowFunction | ts.FunctionExpression =>
  (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && ts.isBlock(n.body);

const toBlockBodyError =
  (ctx: RuleContext) => (n: ts.ArrowFunction | ts.FunctionExpression) =>
    makePurityError(ctx)({
      ruleId: 'no-block-body',
      node: n,
      message:
        'Function block body `{ ... }` is forbidden; functions must be pure expression-bodied.',
      fixGuidance:
        'Convert the block body to a single expression or decompose intermediate steps into a `flow(...)`.',
    });

const checkNoBlockBody = (ctx: RuleContext) =>
  flow(RA.filter(isBlockBodyFn), RA.map(toBlockBodyError(ctx)));

const isAssignmentBinary = (n: ts.Node) =>
  ts.isBinaryExpression(n) &&
  [
    SyntaxKind.EqualsToken,
    SyntaxKind.PlusEqualsToken,
    SyntaxKind.MinusEqualsToken,
    SyntaxKind.AsteriskEqualsToken,
    SyntaxKind.SlashEqualsToken,
    SyntaxKind.PercentEqualsToken,
  ].includes(operatorKindLens.get(n));

const isMutatingUnary = (n: ts.Node) =>
  (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) &&
  (n.operator === SyntaxKind.PlusPlusToken || n.operator === SyntaxKind.MinusMinusToken);

const isAsyncKeyword = (n: ts.Node) => n.kind === SyntaxKind.AsyncKeyword;

const isImperativeNode = (n: ts.Node) =>
  ts.isIfStatement(n) ||
  ts.isSwitchStatement(n) ||
  ts.isForStatement(n) ||
  ts.isForInStatement(n) ||
  ts.isForOfStatement(n) ||
  ts.isWhileStatement(n) ||
  ts.isDoStatement(n) ||
  ts.isTryStatement(n) ||
  ts.isThrowStatement(n) ||
  ts.isAwaitExpression(n) ||
  isAsyncKeyword(n) ||
  isAssignmentBinary(n) ||
  isMutatingUnary(n) ||
  (ts.isVariableDeclarationList(n) && (n.flags & ts.NodeFlags.Const) === 0);

const toImperativeError = (ctx: RuleContext) => (n: ts.Node) =>
  makePurityError(ctx)({
    ruleId: 'no-imperative-constructs',
    node: n,
    message: `Imperative construct (${SyntaxKind[n.kind]}) is forbidden in declarative functional style.`,
    fixGuidance:
      'Replace `if`/`switch` with `ts-pattern`/`B.match`, `for` with `RA.*` combinators, `try/throw` with `Either`/`TaskEither`, and `async/await` with `Task`/`TaskEither`.',
  });

const checkNoImperativeConstructs = (ctx: RuleContext) =>
  flow(RA.filter(isImperativeNode), RA.map(toImperativeError(ctx)));

const isMutatingPropertyAccess = (p: ts.PropertyAccessExpression) =>
  RA.elem(S.Eq)(propNameTextLens.get(p))([
    'push',
    'pop',
    'shift',
    'unshift',
    'splice',
    'sort',
    'reverse',
    'forEach',
  ]) ||
  (ts.isIdentifier(p.expression) &&
    p.expression.text === 'Object' &&
    propNameTextLens.get(p) === 'assign');

const isMutatingMethodCall = (n: ts.Node): n is ts.CallExpression =>
  ts.isCallExpression(n) &&
  ts.isPropertyAccessExpression(n.expression) &&
  isMutatingPropertyAccess(n.expression);

const toMutatingMethodError = (ctx: RuleContext) => (n: ts.CallExpression) =>
  makePurityError(ctx)({
    ruleId: 'no-mutating-methods',
    node: n,
    message: 'Mutating or imperative method call is forbidden.',
    fixGuidance:
      'Use immutable `fp-ts/ReadonlyArray` (`RA.append`, `RA.sort`, `RA.reverse`, `RA.map`) or `monocle-ts` Optics.',
  });

const checkNoMutatingMethods = (ctx: RuleContext) =>
  flow(RA.filter(isMutatingMethodCall), RA.map(toMutatingMethodError(ctx)));

const applyNodeCheck =
  (nodes: ReadonlyArray<ts.Node>) =>
  (check: (ns: ReadonlyArray<ts.Node>) => ReadonlyArray<DiagnosticError>) =>
    check(nodes);

const runChecksOnNodes = (ctx: RuleContext) => (nodes: ReadonlyArray<ts.Node>) =>
  RA.chain(applyNodeCheck(nodes))([
    checkNoBlockBody(ctx),
    checkNoImperativeConstructs(ctx),
    checkNoMutatingMethods(ctx),
  ]);

const runPurityChecks = (ctx: RuleContext) =>
  runChecksOnNodes(ctx)(collectAllNodes(sourceFileLens.get(ctx))(sourceFileLens.get(ctx)));

const identityCtx = (ctx: RuleContext) => ctx;

export const checkDeclarativePurityRules = flow(
  identityCtx,
  runPurityChecks,
) satisfies RuleRunner;
