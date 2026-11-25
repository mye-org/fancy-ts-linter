import { constant, flow } from 'fp-ts/lib/function.js';
import * as B from 'fp-ts/lib/boolean.js';
import * as O from 'fp-ts/lib/Option.js';
import * as RA from 'fp-ts/lib/ReadonlyArray.js';
import { match } from 'ts-pattern';
import * as ts from 'typescript';
import type { BindingInfo, DiagnosticError, RuleContext } from '../model/report.js';

export type RuleRunner = (ctx: RuleContext) => ReadonlyArray<DiagnosticError>;

const isExportModifier = (m: ts.ModifierLike) => m.kind === ts.SyntaxKind.ExportKeyword;

const hasExportKeyword = (node: ts.Node) =>
  ts.canHaveModifiers(node) &&
  O.exists(RA.some(isExportModifier))(O.fromNullable(ts.getModifiers(node)));

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
    ruleId,
    category,
    location: ctx.inspector.getLocation(ctx.sourceFile)(node),
    message,
    snippet: ctx.inspector.getSnippet(ctx.sourceFile)(node),
    fixGuidance,
  });

const makeZeroExportError = (ctx: RuleContext) => [
  makeStructureError(ctx)({
    ruleId: 'single-exported-flow',
    category: 'structure',
    node: ctx.sourceFile,
    message:
      'Module must export exactly one runtime function defined via `flow(...)`, found 0.',
    fixGuidance:
      'Add `export const main = flow(step1, step2) satisfies ExportedType;` as the sole runtime export.',
  }),
];

const makeExtraExportError =
  ({ ctx, count }: { readonly ctx: RuleContext; readonly count: number }) =>
  (stmt: ts.Statement) =>
    makeStructureError(ctx)({
      ruleId: 'single-exported-flow',
      category: 'structure',
      node: stmt,
      message: `Module must have exactly one runtime export, found ${count}.`,
      fixGuidance:
        'Keep only one exported `flow(...)` function and unexport all private helpers.',
    });

const makeMultipleExportErrors = ({
  ctx,
  runtimeExports,
}: {
  readonly ctx: RuleContext;
  readonly runtimeExports: ReadonlyArray<ts.Statement>;
}) => RA.map(makeExtraExportError({ ctx, count: runtimeExports.length }))(runtimeExports.slice(1));

const getRuntimeExports = (ctx: RuleContext) => ({
  ctx,
  runtimeExports: RA.filter(isRuntimeExportStatement)(ctx.sourceFile.statements),
});

const checkExportCount = ({
  ctx,
  runtimeExports,
}: {
  readonly ctx: RuleContext;
  readonly runtimeExports: ReadonlyArray<ts.Statement>;
}) =>
  match(runtimeExports.length)
    .with(0, flow(constant(ctx), makeZeroExportError))
    .with(1, constant([] satisfies ReadonlyArray<DiagnosticError>))
    .otherwise(flow(constant({ ctx, runtimeExports }), makeMultipleExportErrors));

const checkSingleExportCount = flow(getRuntimeExports, checkExportCount);

const isExportedBinding = (b: BindingInfo) => b.isExported;

const checkExportedFlowKind = (ctx: RuleContext) => (b: BindingInfo) =>
  B.match(
    flow(
      constant({
        ruleId: 'single-exported-flow',
        category: 'structure' as const,
        node: b.declaration,
        message: `Exported binding \`${b.name}\` must be a \`flow(...)\` composition.`,
        fixGuidance:
          'Define the exported function using `export const name = flow(a, b) satisfies FnType;`.',
      }),
      makeStructureError(ctx),
      RA.of,
    ),
    constant([] satisfies ReadonlyArray<DiagnosticError>),
  )(b.kind === 'exported-flow');

const checkExportedSatisfies = (ctx: RuleContext) => (b: BindingInfo) =>
  B.match(
    flow(
      constant({
        ruleId: 'export-requires-satisfies',
        category: 'export-satisfies' as const,
        node: b.declaration,
        message: `Exported function \`${b.name}\` must use the \`satisfies\` keyword to pin its type contract.`,
        fixGuidance: 'Append `satisfies ExportedFnType` after `flow(...)`.',
      }),
      makeStructureError(ctx),
      RA.of,
    ),
    constant([] satisfies ReadonlyArray<DiagnosticError>),
  )(b.hasSatisfies);

const checkSingleExportedBinding = (ctx: RuleContext) => (b: BindingInfo) => [
  ...checkExportedFlowKind(ctx)(b),
  ...checkExportedSatisfies(ctx)(b),
];

const checkExportedIsFlowAndSatisfies = (ctx: RuleContext) =>
  flow(RA.filter(isExportedBinding), RA.chain(checkSingleExportedBinding(ctx)))(ctx.ir.bindings);

const isDisallowedTopLevelStatement = (stmt: ts.Statement) =>
  ts.isExportAssignment(stmt) ||
  ts.isClassDeclaration(stmt) ||
  ts.isEnumDeclaration(stmt) ||
  ts.isModuleDeclaration(stmt) ||
  ts.isFunctionDeclaration(stmt) ||
  ts.isExpressionStatement(stmt) ||
  (ts.isVariableStatement(stmt) &&
    (stmt.declarationList.flags & ts.NodeFlags.Const) === 0);

const makeDisallowedStatementError = (ctx: RuleContext) => (stmt: ts.Statement) =>
  makeStructureError(ctx)({
    ruleId: 'no-disallowed-top-level',
    category: 'structure',
    node: stmt,
    message:
      'Disallowed top-level declaration. Only imports, types, private const functions/optics/matchers, and one exported `flow` are allowed.',
    fixGuidance:
      'Convert to `type` / `export type` or a private `const` unary arrow function / `flow`.',
  });

const checkDisallowedTopLevelStatements = (ctx: RuleContext) =>
  flow(
    RA.filter(isDisallowedTopLevelStatement),
    RA.map(makeDisallowedStatementError(ctx)),
  )(ctx.sourceFile.statements);

const isDisallowedOtherBinding = (b: BindingInfo) => !b.isExported && b.kind === 'other';

const makeDisallowedBindingError = (ctx: RuleContext) => (b: BindingInfo) =>
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
    RA.map(makeDisallowedBindingError(ctx)),
  )(ctx.ir.bindings);

const runStructureChecks = (ctx: RuleContext) => [
  ...checkSingleExportCount(ctx),
  ...checkExportedIsFlowAndSatisfies(ctx),
  ...checkDisallowedTopLevelStatements(ctx),
  ...checkDisallowedOtherBindings(ctx),
];

const identityCtx = (ctx: RuleContext) => ctx;

export const checkStructureRules = flow(
  identityCtx,
  runStructureChecks,
) satisfies RuleRunner;
