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

const unwrapParens = (expr: ts.Expression): ts.Expression =>
  ts.isParenthesizedExpression(expr) ? unwrapParens(expr.expression) : expr;

const isCurriedOrPipeline = (b: BindingInfo, unwrapped: ts.Expression): boolean =>
  b.kind === 'sub-flow' ||
  b.kind === 'partial-app' ||
  (ts.isArrowFunction(unwrapped) &&
    !ts.isBlock(unwrapped.body) &&
    ts.isArrowFunction(unwrapParens(unwrapped.body)));

const isGenericFunction = (b: BindingInfo, unwrapped: ts.Expression): boolean =>
  ((ts.isArrowFunction(unwrapped) || ts.isFunctionExpression(unwrapped)) &&
    unwrapped.typeParameters !== undefined &&
    unwrapped.typeParameters.length > 0) ||
  (b.declaration.type !== undefined &&
    ts.isFunctionTypeNode(b.declaration.type) &&
    b.declaration.type.typeParameters !== undefined &&
    b.declaration.type.typeParameters.length > 0);

const isComplexUnion = (t: ts.Type): boolean => {
  if (!t.isUnion()) {
    return false;
  }
  if (t.types.length >= 3) {
    return true;
  }
  const complexMembers = RA.filter(
    (m: ts.Type) => (m.flags & ts.TypeFlags.Object) !== 0 || m.aliasSymbol !== undefined,
  )(t.types);
  return complexMembers.length >= 2;
};

const hasComplexReturnOrWrapperType = (ctx: RuleContext, inferred: ts.Type): boolean => {
  const effects = ctx.inspector.detectEffects(inferred);
  if (RA.some((e: string) => e !== 'Pure')(effects) || ctx.inspector.isOpticType(inferred)) {
    return true;
  }
  return RA.some((sig: ts.Signature) => isComplexUnion(sig.getReturnType()))(
    inferred.getCallSignatures(),
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
      if (
        isCurriedOrPipeline(b, unwrapped) ||
        isGenericFunction(b, unwrapped) ||
        hasComplexReturnOrWrapperType(ctx, inferred)
      ) {
        return [];
      }
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
                'Prefer type inference on simple unexported private functions; omit redundant return-type annotations / `satisfies` unless resolving a TS inference limitation.',
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

export const detectInferenceHygieneHints = ((ctx: RuleContext): ReadonlyArray<AgentHint> =>
  RA.chain(checkPrivateInference(ctx))(ctx.ir.bindings)) satisfies HintRunner;
