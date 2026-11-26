import { flow } from 'fp-ts/lib/function.js';
import * as O from 'fp-ts/lib/Option.js';
import * as RA from 'fp-ts/lib/ReadonlyArray.js';
import * as S from 'fp-ts/lib/string.js';
import * as ts from 'typescript';
import type { DiagnosticError, RuleContext } from '../model/report.js';

export type RuleRunner = (ctx: RuleContext) => ReadonlyArray<DiagnosticError>;

const expandHeadNode =
  ({ sf, queue }: { readonly sf: ts.SourceFile; readonly queue: ReadonlyArray<ts.Node> }) =>
  (head: ts.Node): readonly [ts.Node, ReadonlyArray<ts.Node>] => [
    head,
    [...head.getChildren(sf), ...RA.dropLeft(1)(queue)],
  ];

const stepNodeQueue = (sf: ts.SourceFile) => (queue: ReadonlyArray<ts.Node>) =>
  O.map(expandHeadNode({ sf, queue }))(RA.head(queue));

const collectAllNodes = (sf: ts.SourceFile) =>
  RA.unfold(RA.of<ts.Node>(sf), stepNodeQueue(sf));

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
    location: ctx.inspector.getLocation(ctx.sourceFile)(node),
    message,
    snippet: ctx.inspector.getSnippet(ctx.sourceFile)(node),
    fixGuidance,
  });

const hasConstFlag = (flags: ts.NodeFlags) => (flags & ts.NodeFlags.Const) !== 0;

const hasInitializer = (d: ts.VariableDeclaration) => d.initializer !== undefined;

const isConstVarStmt = (stmt: ts.Statement) =>
  ts.isVariableStatement(stmt) &&
  hasConstFlag(stmt.declarationList.flags) &&
  RA.every(hasInitializer)(stmt.declarationList.declarations);

const isNonEmptyReturnStmt = (stmt: ts.Statement) =>
  ts.isReturnStatement(stmt) && stmt.expression !== undefined;

const isPureConstBindingBlock = (block: ts.Block) =>
  O.exists(RA.every(isConstVarStmt))(RA.init(block.statements)) &&
  O.exists(isNonEmptyReturnStmt)(RA.last(block.statements));

const isDisallowedBlockBodyFn = (n: ts.Node) =>
  (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) &&
  ts.isBlock(n.body) &&
  !isPureConstBindingBlock(n.body);

const toNoBlockBodyError = (ctx: RuleContext) => (n: ts.Node) =>
    makePurityError(ctx)({
      ruleId: 'no-block-body',
      node: n,
      message:
        'Imperative function block body `{ ... }` is forbidden; only expression bodies or pure `const`-binding blocks ending in a single `return <expr>;` are allowed.',
      fixGuidance:
        'Convert the block body to a single expression, a pure `const ...; return <expr>;` block, or decompose steps into a `flow(...)`.',
    });

const checkNoBlockBody = (ctx: RuleContext) =>
  flow(RA.filter(isDisallowedBlockBodyFn), RA.map(toNoBlockBodyError(ctx)));

const isAssignmentBinary = (n: ts.Node) =>
  ts.isBinaryExpression(n) &&
  [
    ts.SyntaxKind.EqualsToken,
    ts.SyntaxKind.PlusEqualsToken,
    ts.SyntaxKind.MinusEqualsToken,
    ts.SyntaxKind.AsteriskEqualsToken,
    ts.SyntaxKind.SlashEqualsToken,
    ts.SyntaxKind.PercentEqualsToken,
  ].includes(n.operatorToken.kind);

const isMutatingUnary = (n: ts.Node) =>
  (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) &&
  (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken);

const isAsyncKeyword = (n: ts.Node) => n.kind === ts.SyntaxKind.AsyncKeyword;

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
  (ts.isVariableDeclarationList(n) && !hasConstFlag(n.flags));

const toNoImperativeError = (ctx: RuleContext) => (n: ts.Node) =>
  makePurityError(ctx)({
    ruleId: 'no-imperative-constructs',
    node: n,
    message: `Imperative construct (${ts.SyntaxKind[n.kind]}) is forbidden in declarative functional style.`,
    fixGuidance:
      'Replace `if`/`switch` with `ts-pattern`/`B.match`, `for` with `RA.*` combinators, `try/throw` with `Either`/`TaskEither`, and `async/await` with `Task`/`TaskEither`.',
  });

const checkNoImperativeConstructs = (ctx: RuleContext) =>
  flow(RA.filter(isImperativeNode), RA.map(toNoImperativeError(ctx)));

const isMutatingMethodCall = (n: ts.Node) =>
  ts.isCallExpression(n) &&
  ts.isPropertyAccessExpression(n.expression) &&
  (RA.elem(S.Eq)(n.expression.name.text)([
    'push',
    'pop',
    'shift',
    'unshift',
    'splice',
    'sort',
    'reverse',
    'forEach',
  ]) ||
    (ts.isIdentifier(n.expression.expression) &&
      n.expression.expression.text === 'Object' &&
      n.expression.name.text === 'assign'));

const toNoMutatingMethodError = (ctx: RuleContext) => (n: ts.Node) =>
  makePurityError(ctx)({
    ruleId: 'no-mutating-methods',
    node: n,
    message: 'Mutating or imperative method call is forbidden.',
    fixGuidance:
      'Use immutable `fp-ts/ReadonlyArray` (`RA.append`, `RA.sort`, `RA.reverse`, `RA.map`) or `monocle-ts` Optics.',
  });

const checkNoMutatingMethods = (ctx: RuleContext) =>
  flow(RA.filter(isMutatingMethodCall), RA.map(toNoMutatingMethodError(ctx)));

export const checkDeclarativePurityRules = ((ctx: RuleContext): ReadonlyArray<DiagnosticError> => {
  const nodes = collectAllNodes(ctx.sourceFile);
  return [
    ...checkNoBlockBody(ctx)(nodes),
    ...checkNoImperativeConstructs(ctx)(nodes),
    ...checkNoMutatingMethods(ctx)(nodes),
  ];
}) satisfies RuleRunner;
