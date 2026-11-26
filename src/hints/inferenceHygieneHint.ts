import * as B from 'fp-ts/lib/boolean.js';
import { constant } from 'fp-ts/lib/function.js';
import * as O from 'fp-ts/lib/Option.js';
import * as RA from 'fp-ts/lib/ReadonlyArray.js';
import { Lens } from 'monocle-ts';
import * as ts from 'typescript';
import type { AgentHint, BindingInfo, RuleContext } from '../model/report.js';

export type HintRunner = (ctx: RuleContext) => ReadonlyArray<AgentHint>;

type EquivalenceInput = {
  readonly checker: ts.TypeChecker;
  readonly declared: ts.Type;
  readonly inferred: ts.Type;
};

type BindingExprInput = {
  readonly b: BindingInfo;
  readonly unwrapped: ts.Expression;
};

type ContextTypeInput = {
  readonly ctx: RuleContext;
  readonly inferred: ts.Type;
};

type BindingCheckInput = {
  readonly ctx: RuleContext;
  readonly b: BindingInfo;
};

const bindingLineLens = Lens.fromPath<BindingInfo>()(['location', 'line']);
const bindingColLens = Lens.fromPath<BindingInfo>()(['location', 'column']);

const isEquivalentToInferred = ({ checker, declared, inferred }: EquivalenceInput) =>
  (inferred.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) === 0 &&
  checker.isTypeAssignableTo(inferred, declared) &&
  checker.isTypeAssignableTo(declared, inferred);

const pairSame = <A>(a: A) => [a, a] as const;

const pairParenExpr = (p: ts.ParenthesizedExpression) => pairSame(p.expression);

const stepParen = (expr: ts.Expression) =>
  O.map(pairParenExpr)(O.fromPredicate(ts.isParenthesizedExpression)(expr));

const unwrapParens = (expr: ts.Expression) =>
  O.getOrElse(constant(expr))(RA.last(RA.unfold(expr, stepParen)));

const isCurriedOrPipeline = ({ b, unwrapped }: BindingExprInput) =>
  b.kind === 'sub-flow' ||
  b.kind === 'partial-app' ||
  (ts.isArrowFunction(unwrapped) &&
    !ts.isBlock(unwrapped.body) &&
    ts.isArrowFunction(unwrapParens(unwrapped.body)));

const isGenericFunction = ({ b, unwrapped }: BindingExprInput) =>
  ((ts.isArrowFunction(unwrapped) || ts.isFunctionExpression(unwrapped)) &&
    unwrapped.typeParameters !== undefined &&
    unwrapped.typeParameters.length > 0) ||
  (b.declaration.type !== undefined &&
    ts.isFunctionTypeNode(b.declaration.type) &&
    b.declaration.type.typeParameters !== undefined &&
    b.declaration.type.typeParameters.length > 0);

const isComplexTypeMember = (m: ts.Type) =>
  (m.flags & ts.TypeFlags.Object) !== 0 || m.aliasSymbol !== undefined;

const isUnionType = (t: ts.Type) => t.isUnion();

const checkUnionMembers = (t: ts.UnionType) =>
  B.match(
    constant(RA.filter(isComplexTypeMember)(t.types).length >= 2),
    constant(true),
  )(t.types.length >= 3);

const isComplexUnion = (t: ts.Type) =>
  O.exists(checkUnionMembers)(O.fromPredicate(isUnionType)(t));

const isNonPureEffect = (e: string) => e !== 'Pure';

const sigReturnsComplexUnion = (sig: ts.Signature) => isComplexUnion(sig.getReturnType());

const hasComplexReturnOrWrapperType = ({ ctx, inferred }: ContextTypeInput) => {
  const effects = ctx.inspector.detectEffects(inferred);
  return (
    RA.some(isNonPureEffect)(effects) ||
    ctx.inspector.isOpticType(inferred) ||
    RA.some(sigReturnsComplexUnion)(inferred.getCallSignatures())
  );
};

const makeInferenceHygieneHint = (b: BindingInfo) => {
  const hints: ReadonlyArray<AgentHint> = [
    {
      hintId: `inference-hygiene-${b.name}`,
      category: 'inference-hygiene',
      priority: 'low',
      location: { line: bindingLineLens.get(b), column: bindingColLens.get(b) },
      evidence: `Unexported binding \`${b.name}\` has an explicit return type or \`satisfies\` that matches TypeScript's inferred type (${b.signature}).`,
      suggestion:
        'Prefer type inference on simple unexported private functions; omit redundant return-type annotations / `satisfies` unless resolving a TS inference limitation.',
      suggestedSignature: O.none,
      researchQuestions: [
        `Does removing the annotation on \`${b.name}\` keep \`tsc\` passing with the same inferred type?`,
      ],
    },
  ];
  return hints;
};

const checkExprInference =
  ({ ctx, b }: BindingCheckInput) =>
  (expr: ts.Expression) => {
    const unwrapped = ctx.inspector.unwrapSatisfiesAndParens(expr);
    const inferred = ctx.checker.getTypeAtLocation(unwrapped);
    const isSkipped =
      isCurriedOrPipeline({ b, unwrapped }) ||
      isGenericFunction({ b, unwrapped }) ||
      hasComplexReturnOrWrapperType({ ctx, inferred });
    const declared = ctx.checker.getTypeAtLocation(b.declaration);
    const redundant =
      !isSkipped && isEquivalentToInferred({ checker: ctx.checker, declared, inferred });
    return B.match(RA.zero<AgentHint>, constant(makeInferenceHygieneHint(b)))(redundant);
  };

const checkPrivateInference = (ctx: RuleContext) => (b: BindingInfo) => {
  const shouldSkip = b.isExported || (!b.hasExplicitReturnType && !b.hasSatisfies);
  return B.match(
    constant(O.match(RA.zero<AgentHint>, checkExprInference({ ctx, b }))(b.initializer)),
    RA.zero<AgentHint>,
  )(shouldSkip);
};

export const detectInferenceHygieneHints = ((ctx: RuleContext): ReadonlyArray<AgentHint> =>
  RA.chain(checkPrivateInference(ctx))(ctx.ir.bindings)) satisfies HintRunner;
