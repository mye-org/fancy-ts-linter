import { flow } from 'fp-ts/lib/function.js';
import * as O from 'fp-ts/lib/Option.js';
import * as RA from 'fp-ts/lib/ReadonlyArray.js';
import * as ts from 'typescript';
import type { AgentHint, BindingInfo, RuleContext } from '../model/report.js';

export type HintRunner = (ctx: RuleContext) => ReadonlyArray<AgentHint>;

const isEquivalentToInferred =
  (checker: ts.TypeChecker) =>
  (declared: ts.Type) =>
  (inferred: ts.Type): boolean => {
    if ((inferred.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) {
      return false;
    }
    return (
      checker.isTypeAssignableTo(inferred, declared) &&
      checker.isTypeAssignableTo(declared, inferred)
    );
  };

const checkPrivateInference = (ctx: RuleContext) => (b: BindingInfo): ReadonlyArray<AgentHint> => {
  if (b.isExported || (!b.hasExplicitReturnType && !b.hasSatisfies)) {
    return [];
  }
  return O.match(
    () => [] as ReadonlyArray<AgentHint>,
    (expr: ts.Expression): ReadonlyArray<AgentHint> => {
      const unwrapped = ctx.inspector.unwrapSatisfiesAndParens(expr);
      const inferred = ctx.checker.getTypeAtLocation(unwrapped);
      const declared = ctx.checker.getTypeAtLocation(b.declaration);
      const redundant = isEquivalentToInferred(ctx.checker)(declared)(inferred);

      return redundant
        ? [
            {
              hintId: `inference-hygiene-${b.name}`,
              category: 'inference-hygiene',
              priority: 'low',
              location: { line: b.location.line, column: b.location.column },
              evidence: `Unexported binding \`${b.name}\` has an explicit return type or \`satisfies\` that matches TypeScript's inferred type (${b.signature}).`,
              suggestion:
                'Prefer type inference on unexported private functions; omit redundant return-type annotations / `satisfies` unless resolving a TS inference limitation.',
              suggestedSignature: O.none,
              researchQuestions: [
                `Does removing the annotation on \`${b.name}\` keep \`tsc\` passing with the same inferred type?`,
              ],
            },
          ]
        : [];
    },
  )(b.initializer);
};

const runInferenceHygiene = (ctx: RuleContext): ReadonlyArray<AgentHint> =>
  RA.chain(checkPrivateInference(ctx))(ctx.ir.bindings);

const identityCtx = (ctx: RuleContext) => ctx;

export const detectInferenceHygieneHints = flow(
  identityCtx,
  runInferenceHygiene,
) satisfies HintRunner;
