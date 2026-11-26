import * as B from 'fp-ts/lib/boolean.js';
import { constant, flow } from 'fp-ts/lib/function.js';
import * as O from 'fp-ts/lib/Option.js';
import * as RA from 'fp-ts/lib/ReadonlyArray.js';
import { Lens } from 'monocle-ts';
import { iso } from 'newtype-ts';
import * as ts from 'typescript';
import type {
  BindingInfo,
  DiagnosticError,
  DiagnosticMessage,
  FixGuidance,
  RuleContext,
  RuleId,
} from '../model/report.js';

export type RuleRunner = (ctx: RuleContext) => ReadonlyArray<DiagnosticError>;

const isoRuleId = iso<RuleId>();
const isoDiagMsg = iso<DiagnosticMessage>();
const isoFixGuidance = iso<FixGuidance>();

const sourceFileStatementsLens = Lens.fromPath<RuleContext>()(['sourceFile', 'statements']);

const irBindingsLens = Lens.fromPath<RuleContext>()(['ir', 'bindings']);

const isExportModifier = (m: ts.ModifierLike) => m.kind === ts.SyntaxKind.ExportKeyword;

const hasExportKeyword = (node: ts.Node) =>
  ts.canHaveModifiers(node) && O.exists(RA.some(isExportModifier))(O.fromNullable(ts.getModifiers(node)));

const isRuntimeExportStatement = (stmt: ts.Statement) =>
  (ts.isVariableStatement(stmt) && hasExportKeyword(stmt)) ||
  ((ts.isFunctionDeclaration(stmt) ||
    ts.isClassDeclaration(stmt) ||
    ts.isEnumDeclaration(stmt)) &&
    hasExportKeyword(stmt)) ||
  ts.isExportAssignment(stmt) ||
  (ts.isExportDeclaration(stmt) && !stmt.isTypeOnly);

type StructureErrorInput = {
  readonly ruleId: string;
  readonly category: DiagnosticError['category'];
  readonly node: ts.Node;
  readonly message: string;
  readonly fixGuidance: string;
};

const makeStructureError =
  (ctx: RuleContext) =>
  ({ ruleId, category, node, message, fixGuidance }: StructureErrorInput): DiagnosticError => ({
    ruleId: isoRuleId.wrap(ruleId),
    category,
    location: ctx.inspector.getLocation(ctx.sourceFile)(node),
    message: isoDiagMsg.wrap(message),
    snippet: ctx.inspector.getSnippet(ctx.sourceFile)(node),
    fixGuidance: isoFixGuidance.wrap(fixGuidance),
  });

const toZeroExportsError = (ctx: RuleContext) => [
  makeStructureError(ctx)({
    ruleId: 'single-exported-function',
    category: 'structure',
    node: ctx.sourceFile,
    message: 'Module must export exactly one runtime function, found 0.',
    fixGuidance:
      'Add `export const main = <fn> satisfies ExportedType;` as the sole runtime export.',
  }),
];

const toExtraExportError =
  ({ ctx, totalCount }: { readonly ctx: RuleContext; readonly totalCount: number }) =>
  (stmt: ts.Statement) =>
    makeStructureError(ctx)({
      ruleId: 'single-exported-function',
      category: 'structure',
      node: stmt,
      message: `Module must have exactly one runtime export, found ${totalCount}.`,
      fixGuidance: 'Keep only one exported function and unexport all private helpers.',
    });

const toMultipleExportsErrors = ({
  ctx,
  runtimeExports,
}: {
  readonly ctx: RuleContext;
  readonly runtimeExports: ReadonlyArray<ts.Statement>;
}) =>
  RA.map(toExtraExportError({ ctx, totalCount: runtimeExports.length }))(
    RA.dropLeft(1)(runtimeExports),
  );

const handleInvalidExportCount = ({
  ctx,
  runtimeExports,
}: {
  readonly ctx: RuleContext;
  readonly runtimeExports: ReadonlyArray<ts.Statement>;
}) =>
  B.match(
    () => toMultipleExportsErrors({ ctx, runtimeExports }),
    () => toZeroExportsError(ctx),
  )(runtimeExports.length === 0);

const checkSingleExportCount = (ctx: RuleContext) => {
  const runtimeExports = RA.filter(isRuntimeExportStatement)(sourceFileStatementsLens.get(ctx));
  return B.match(
    () => handleInvalidExportCount({ ctx, runtimeExports }),
    constant(RA.empty),
  )(runtimeExports.length === 1);
};

const isAllowedExportKind = (kind: BindingInfo['kind']) =>
  ['exported-flow', 'leaf-fn', 'partial-app', 'adt-matcher'].includes(kind);

const checkBindingFnKind = (ctx: RuleContext) => (b: BindingInfo) =>
  B.match(
    (): ReadonlyArray<DiagnosticError> => [
      makeStructureError(ctx)({
        ruleId: 'single-exported-function',
        category: 'structure',
        node: b.declaration,
        message: `Exported binding \`${b.name}\` must be a unary function (or \`flow(...)\` composition).`,
        fixGuidance:
          'Define the exported function using `export const name = fn satisfies FnType;` (e.g., an arrow function, `flow(...)`, or helper reference).',
      }),
    ],
    constant(RA.empty),
  )(isAllowedExportKind(b.kind));

const pairSame = <A>(a: A) => [a, a] as const;

const pairParenExpr = (p: ts.ParenthesizedExpression) => pairSame(p.expression);

const stepParen = (expr: ts.Expression) =>
  O.map(pairParenExpr)(O.fromPredicate(ts.isParenthesizedExpression)(expr));

const unwrapParens = (expr: ts.Expression) =>
  O.getOrElse(constant(expr))(RA.last(RA.unfold(expr, stepParen)));

const getSatisfiesNode = (b: BindingInfo) =>
  O.chain(flow(unwrapParens, O.fromPredicate(ts.isSatisfiesExpression)))(b.initializer);

const hasCallSignature = (t: ts.Type) => RA.isNonEmpty(t.getCallSignatures());

const satisfiesSpecifiesFnType =
  (ctx: RuleContext) =>
  (node: ts.SatisfiesExpression) =>
    hasCallSignature(ctx.checker.getTypeFromTypeNode(node.type));

const hasBindingSatisfies = (b: BindingInfo) =>
  b.annotation === 'satisfies' || b.annotation === 'both';

const hasValidSatisfiesType = (ctx: RuleContext) => (b: BindingInfo) =>
  hasBindingSatisfies(b) && O.exists(satisfiesSpecifiesFnType(ctx))(getSatisfiesNode(b));

const checkBindingSatisfies = (ctx: RuleContext) => (b: BindingInfo) =>
  B.match(
    (): ReadonlyArray<DiagnosticError> => [
      makeStructureError(ctx)({
        ruleId: 'export-requires-satisfies',
        category: 'export-satisfies',
        node: b.declaration,
        message: `Exported function \`${b.name}\` must use the \`satisfies\` keyword to specify its function type and return type.`,
        fixGuidance:
          'Append `satisfies ExportedFnType` (e.g. `(input: Input) => Output`) after the exported function.',
      }),
    ],
    constant(RA.empty),
  )(hasValidSatisfiesType(ctx)(b));

const checkExportedBinding = (ctx: RuleContext) => (b: BindingInfo) => [
  ...checkBindingFnKind(ctx)(b),
  ...checkBindingSatisfies(ctx)(b),
];

const isExportedBinding = (b: BindingInfo) => b.visibility === 'exported';

const checkExportedFunctionAndSatisfies = (ctx: RuleContext) =>
  RA.chain(checkExportedBinding(ctx))(RA.filter(isExportedBinding)(irBindingsLens.get(ctx)));

const isDisallowedTopLevelStatement = (stmt: ts.Statement) =>
  ts.isExportAssignment(stmt) ||
  ts.isClassDeclaration(stmt) ||
  ts.isEnumDeclaration(stmt) ||
  ts.isModuleDeclaration(stmt) ||
  ts.isFunctionDeclaration(stmt) ||
  ts.isExpressionStatement(stmt) ||
  (ts.isVariableStatement(stmt) && (stmt.declarationList.flags & ts.NodeFlags.Const) === 0);

const toDisallowedStatementError = (ctx: RuleContext) => (stmt: ts.Statement) =>
  makeStructureError(ctx)({
    ruleId: 'no-disallowed-top-level',
    category: 'structure',
    node: stmt,
    message:
      'Disallowed top-level declaration. Only imports, types, private const functions/optics/matchers, and one exported function are allowed.',
    fixGuidance:
      'Convert to `type` / `export type` or a private `const` unary arrow function / `flow`.',
  });

const checkDisallowedTopLevelStatements = (ctx: RuleContext) =>
  flow(
    RA.filter(isDisallowedTopLevelStatement),
    RA.map(toDisallowedStatementError(ctx)),
  )(sourceFileStatementsLens.get(ctx));

const isDisallowedOtherBinding = (b: BindingInfo) =>
  b.visibility !== 'exported' && b.kind === 'other';

const toDisallowedOtherBindingError = (ctx: RuleContext) => (b: BindingInfo) =>
  makeStructureError(ctx)({
    ruleId: 'no-disallowed-top-level',
    category: 'structure',
    node: b.declaration,
    message: `Top-level constant \`${b.name}\` is not a unary function, \`flow\`, Optic, ADT matcher, or typeclass instance.`,
    fixGuidance:
      'Inline into a domain type/function, convert to a unary function/Optic, or lift into a module parameter.',
  });

const checkDisallowedOtherBindings = (ctx: RuleContext) =>
  flow(
    RA.filter(isDisallowedOtherBinding),
    RA.map(toDisallowedOtherBindingError(ctx)),
  )(irBindingsLens.get(ctx));

export const checkStructureRules = ((ctx: RuleContext): ReadonlyArray<DiagnosticError> => [
  ...checkSingleExportCount(ctx),
  ...checkExportedFunctionAndSatisfies(ctx),
  ...checkDisallowedTopLevelStatements(ctx),
  ...checkDisallowedOtherBindings(ctx),
]) satisfies RuleRunner;
