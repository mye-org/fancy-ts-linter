import { flow } from 'fp-ts/lib/function.js';
import * as RA from 'fp-ts/lib/ReadonlyArray.js';
import * as S from 'fp-ts/lib/string.js';
import * as ts from 'typescript';
import type { DiagnosticError, RuleContext } from '../model/report.js';

export type RuleRunner = (ctx: RuleContext) => ReadonlyArray<DiagnosticError>;

const collectAllNodes = (sf: ts.SourceFile) => (node: ts.Node): ReadonlyArray<ts.Node> => [
  node,
  ...RA.chain(collectAllNodes(sf))(node.getChildren(sf)),
];

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

const checkNoBlockBody =
  (ctx: RuleContext) =>
  (nodes: ReadonlyArray<ts.Node>): ReadonlyArray<DiagnosticError> =>
    flow(
      RA.filter(
        (n: ts.Node): n is ts.ArrowFunction | ts.FunctionExpression =>
          (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && ts.isBlock(n.body),
      ),
      RA.map((n: ts.ArrowFunction | ts.FunctionExpression) =>
        makePurityError(ctx)({
          ruleId: 'no-block-body',
          node: n,
          message:
            'Function block body `{ ... }` is forbidden; functions must be pure expression-bodied.',
          fixGuidance:
            'Convert the block body to a single expression or decompose intermediate steps into a `flow(...)`.',
        }),
      ),
    )(nodes);

const assignmentKinds: ReadonlyArray<ts.SyntaxKind> = [
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.PercentEqualsToken,
];

const isAssignmentBinary = (n: ts.Node): boolean =>
  ts.isBinaryExpression(n) &&
  assignmentKinds.includes(n.operatorToken.kind);

const isMutatingUnary = (n: ts.Node): boolean =>
  (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) &&
  (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken);

const isAsyncKeyword = (n: ts.Node): boolean =>
  n.kind === ts.SyntaxKind.AsyncKeyword;

const isImperativeNode = (n: ts.Node): boolean =>
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

const checkNoImperativeConstructs =
  (ctx: RuleContext) =>
  (nodes: ReadonlyArray<ts.Node>): ReadonlyArray<DiagnosticError> =>
    flow(
      RA.filter(isImperativeNode),
      RA.map((n: ts.Node) =>
        makePurityError(ctx)({
          ruleId: 'no-imperative-constructs',
          node: n,
          message: `Imperative construct (${ts.SyntaxKind[n.kind]}) is forbidden in declarative functional style.`,
          fixGuidance:
            'Replace `if`/`switch` with `ts-pattern`/`B.match`, `for` with `RA.*` combinators, `try/throw` with `Either`/`TaskEither`, and `async/await` with `Task`/`TaskEither`.',
        }),
      ),
    )(nodes);

const mutatingMethodNames: ReadonlyArray<string> = [
  'push',
  'pop',
  'shift',
  'unshift',
  'splice',
  'sort',
  'reverse',
  'forEach',
];

const isMutatingMethodCall = (n: ts.Node): n is ts.CallExpression =>
  ts.isCallExpression(n) &&
  ts.isPropertyAccessExpression(n.expression) &&
  (RA.elem(S.Eq)(n.expression.name.text)(mutatingMethodNames) ||
    (ts.isIdentifier(n.expression.expression) &&
      n.expression.expression.text === 'Object' &&
      n.expression.name.text === 'assign'));

const checkNoMutatingMethods =
  (ctx: RuleContext) =>
  (nodes: ReadonlyArray<ts.Node>): ReadonlyArray<DiagnosticError> =>
    flow(
      RA.filter(isMutatingMethodCall),
      RA.map((n: ts.CallExpression) =>
        makePurityError(ctx)({
          ruleId: 'no-mutating-methods',
          node: n,
          message: 'Mutating or imperative method call is forbidden.',
          fixGuidance:
            'Use immutable `fp-ts/ReadonlyArray` (`RA.append`, `RA.sort`, `RA.reverse`, `RA.map`) or `monocle-ts` Optics.',
        }),
      ),
    )(nodes);

const runPurityChecks = (ctx: RuleContext): ReadonlyArray<DiagnosticError> => {
  const nodes = collectAllNodes(ctx.sourceFile)(ctx.sourceFile);
  return [
    ...checkNoBlockBody(ctx)(nodes),
    ...checkNoImperativeConstructs(ctx)(nodes),
    ...checkNoMutatingMethods(ctx)(nodes),
  ];
};

const identityCtx = (ctx: RuleContext) => ctx;

export const checkDeclarativePurityRules = flow(
  identityCtx,
  runPurityChecks,
) satisfies RuleRunner;
