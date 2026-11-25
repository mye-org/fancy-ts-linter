import * as B from 'fp-ts/lib/boolean.js';
import { constant, flow } from 'fp-ts/lib/function.js';
import * as O from 'fp-ts/lib/Option.js';
import * as RA from 'fp-ts/lib/ReadonlyArray.js';
import * as ts from 'typescript';
import type { AgentHint, BindingInfo, RuleContext } from '../model/report.js';

export type HintRunner = (ctx: RuleContext) => ReadonlyArray<AgentHint>;

type EquivalenceCheck = {
  readonly checker: ts.TypeChecker;
  readonly declared: ts.Type;
  readonly inferred: ts.Type;
};

type PrivateCheckInput = {
  readonly ctx: RuleContext;
  readonly b: BindingInfo;
};

const isAnyOrUnknown = (flags: ts.TypeFlags) =>
  (flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;

const isEquivalentToInferred = (input: EquivalenceCheck) =>
  !isAnyOrUnknown(input.inferred.flags) &&
  input.checker.isTypeAssignableTo(input.inferred, input.declared) &&
  input.checker.isTypeAssignableTo(input.declared, input.inferred);

const needsInferenceCheck = (b: BindingInfo) =>
  !b.isExported && (b.hasExplicitReturnType || b.hasSatisfies);

const getInitializer = (b: BindingInfo) => b.initializer;

const buildHintForExpr =
  (input: PrivateCheckInput) =>
  (expr: ts.Expression) =>
    B.match(
      constant(RA.zero<AgentHint>()),
      constant([
        {
          hintId: `inference-hygiene-${input.b.name}`,
          category: 'inference-hygiene' as const,
          priority: 'low' as const,
          location: { line: input.b.location.line, column: input.b.location.column },
          evidence: `Unexported binding \`${input.b.name}\` has an explicit return type or \`satisfies\` that matches TypeScript's inferred type (${input.b.signature}).`,
          suggestion:
            'Prefer type inference on unexported private functions; omit redundant return-type annotations / `satisfies` unless resolving a TS inference limitation.',
          suggestedSignature: O.none,
          researchQuestions: [
            `Does removing the annotation on \`${input.b.name}\` keep \`tsc\` passing with the same inferred type?`,
          ],
        },
      ]),
    )(
      isEquivalentToInferred({
        checker: input.ctx.checker,
        declared: input.ctx.checker.getTypeAtLocation(input.b.declaration),
        inferred: input.ctx.checker.getTypeAtLocation(
          input.ctx.inspector.unwrapSatisfiesAndParens(expr),
        ),
      }),
    );

const checkPrivateInference =
  (ctx: RuleContext) =>
  (b: BindingInfo) =>
    flow(
      O.fromPredicate(needsInferenceCheck),
      O.chain(getInitializer),
      O.match(constant(RA.zero<AgentHint>()), buildHintForExpr({ ctx, b })),
    )(b);

const runInferenceHygiene = (ctx: RuleContext) =>
  RA.chain(checkPrivateInference(ctx))(ctx.ir.bindings);

const identityCtx = (ctx: RuleContext) => ctx;

export const detectInferenceHygieneHints = flow(
  identityCtx,
  runInferenceHygiene,
) satisfies HintRunner;
