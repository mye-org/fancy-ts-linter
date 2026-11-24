import { constant, flow } from 'fp-ts/lib/function.js';
import * as B from 'fp-ts/lib/boolean.js';
import * as O from 'fp-ts/lib/Option.js';
import * as RA from 'fp-ts/lib/ReadonlyArray.js';
import * as ts from 'typescript';
import type { BindingInfo, DiagnosticError, RuleContext } from '../model/report.js';

export type RuleRunner = (ctx: RuleContext) => ReadonlyArray<DiagnosticError>;

const hasExportKeyword = (node: ts.Node): boolean =>
  ts.canHaveModifiers(node) &&
  O.exists(RA.some((m: ts.ModifierLike) => m.kind === ts.SyntaxKind.ExportKeyword))(
    O.fromNullable(ts.getModifiers(node)),
  );

const isRuntimeExportStatement = (stmt: ts.Statement): boolean =>
  (ts.isVariableStatement(stmt) && hasExportKeyword(stmt)) ||
  ((ts.isFunctionDeclaration(stmt) ||
    ts.isClassDeclaration(stmt) ||
    ts.isEnumDeclaration(stmt)) &&
    hasExportKeyword(stmt)) ||
  ts.isExportAssignment(stmt) ||
  (ts.isExportDeclaration(stmt) && !stmt.isTypeOnly);

const makeStructureError =
  (ctx: RuleContext) =>
  (ruleId: string) =>
  (category: DiagnosticError['category']) =>
  (node: ts.Node) =>
  (message: string) =>
  (fixGuidance: string): DiagnosticError => ({
    ruleId,
    category,
    location: ctx.inspector.getLocation(ctx.sourceFile)(node),
    message,
    snippet: ctx.inspector.getSnippet(ctx.sourceFile)(node),
    fixGuidance,
  });

const checkSingleExportCount = (ctx: RuleContext): ReadonlyArray<DiagnosticError> => {
  const runtimeExports = RA.filter(isRuntimeExportStatement)(ctx.sourceFile.statements);
  return B.match(
    () =>
      runtimeExports.length === 0
        ? [
            makeStructureError(ctx)('single-exported-flow')('structure')(ctx.sourceFile)(
              'Module must export exactly one runtime function defined via `flow(...)`, found 0.',
            )(
              'Add `export const main = flow(step1, step2) satisfies ExportedType;` as the sole runtime export.',
            ),
          ]
        : RA.map((stmt: ts.Statement) =>
            makeStructureError(ctx)('single-exported-flow')('structure')(stmt)(
              `Module must have exactly one runtime export, found ${runtimeExports.length}.`,
            )('Keep only one exported `flow(...)` function and unexport all private helpers.'),
          )(runtimeExports.slice(1)),
    constant([] as ReadonlyArray<DiagnosticError>),
  )(runtimeExports.length === 1);
};

const checkExportedIsFlowAndSatisfies = (ctx: RuleContext): ReadonlyArray<DiagnosticError> => {
  const exportedBindings = RA.filter((b: BindingInfo) => b.isExported)(ctx.ir.bindings);
  return RA.chain((b: BindingInfo): ReadonlyArray<DiagnosticError> => {
    const flowErr =
      b.kind !== 'exported-flow'
        ? [
            makeStructureError(ctx)('single-exported-flow')('structure')(b.declaration)(
              `Exported binding \`${b.name}\` must be a \`flow(...)\` composition.`,
            )('Define the exported function using `export const name = flow(a, b) satisfies FnType;`.'),
          ]
        : ([] as ReadonlyArray<DiagnosticError>);
    const satisfiesErr = !b.hasSatisfies
      ? [
          makeStructureError(ctx)('export-requires-satisfies')('export-satisfies')(b.declaration)(
            `Exported function \`${b.name}\` must use the \`satisfies\` keyword to pin its type contract.`,
          )('Append `satisfies ExportedFnType` after `flow(...)`.'),
        ]
      : ([] as ReadonlyArray<DiagnosticError>);
    return [...flowErr, ...satisfiesErr];
  })(exportedBindings);
};

const isDisallowedTopLevelStatement = (stmt: ts.Statement): boolean =>
  ts.isExportAssignment(stmt) ||
  ts.isClassDeclaration(stmt) ||
  ts.isEnumDeclaration(stmt) ||
  ts.isModuleDeclaration(stmt) ||
  ts.isFunctionDeclaration(stmt) ||
  ts.isExpressionStatement(stmt) ||
  (ts.isVariableStatement(stmt) &&
    (stmt.declarationList.flags & ts.NodeFlags.Const) === 0);

const checkDisallowedTopLevelStatements = (ctx: RuleContext): ReadonlyArray<DiagnosticError> =>
  flow(
    RA.filter(isDisallowedTopLevelStatement),
    RA.map((stmt: ts.Statement) =>
      makeStructureError(ctx)('no-disallowed-top-level')('structure')(stmt)(
        'Disallowed top-level declaration. Only imports, types, private const functions/optics/matchers, and one exported `flow` are allowed.',
      )('Convert to `type` / `export type` or a private `const` unary arrow function / `flow`.'),
    ),
  )(ctx.sourceFile.statements);

const checkDisallowedOtherBindings = (ctx: RuleContext): ReadonlyArray<DiagnosticError> =>
  flow(
    RA.filter((b: BindingInfo) => !b.isExported && b.kind === 'other'),
    RA.map((b: BindingInfo) =>
      makeStructureError(ctx)('no-disallowed-top-level')('structure')(b.declaration)(
        `Top-level constant \`${b.name}\` is not a unary function, \`flow\`, Optic, ADT matcher, or typeclass instance.`,
      )(
        'Inline into a domain type/function, convert to a unary function/Optic, or lift into a module parameter.',
      ),
    ),
  )(ctx.ir.bindings);

const runStructureChecks = (ctx: RuleContext): ReadonlyArray<DiagnosticError> => [
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
