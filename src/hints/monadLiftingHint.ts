import * as B from 'fp-ts/lib/boolean.js';
import { flow } from 'fp-ts/lib/function.js';
import * as O from 'fp-ts/lib/Option.js';
import * as RA from 'fp-ts/lib/ReadonlyArray.js';
import * as ts from 'typescript';
import { iso } from 'newtype-ts';
import type { AgentHint, BindingInfo, RuleContext, HintEvidence, HintId, HintSuggestion } from '../model/report.js';

const isoHintId = iso<HintId>();
const isoHintEvidence = iso<HintEvidence>();
const isoHintSuggestion = iso<HintSuggestion>();

export type HintRunner = (ctx: RuleContext) => ReadonlyArray<AgentHint>;

type ReaderCandidate = {
  readonly b: BindingInfo;
  readonly depType: string;
};

type TargetBinding = {
  readonly context: RuleContext;
  readonly binding: BindingInfo;
};

const getIrBindings = (ctx: RuleContext) => ctx.ir.bindings;

const getBindingType = (ctx: RuleContext) => (b: BindingInfo) =>
  ctx.checker.getTypeAtLocation(b.declaration);

const renderType = (ctx: RuleContext) => (t: ts.Type) => ctx.inspector.formatType(t);

const getBindingLocation = (b: BindingInfo) => ({
  line: b.location.line,
  column: b.location.column,
});

const readCallSignatures = (t: ts.Type) => t.getCallSignatures();

const getFirstParam = (sig: ts.Signature) => RA.head(sig.getParameters());

const isEnvDepType = (typeText: string) => /config|env|deps|ctx|repo|client/i.test(typeText);

const hasSingleCurriedParam = (sig: ts.Signature) =>
  sig.getReturnType().getCallSignatures().length > 0 && sig.getParameters().length === 1;

const checkParamSymbol = (target: TargetBinding) => (param: ts.Symbol) => {
  const paramType = target.context.checker.getTypeOfSymbolAtLocation(
    param,
    target.binding.declaration,
  );
  const typeText = renderType(target.context)(paramType);
  return B.match<O.Option<string>>(
    () => O.none,
    () => O.some(typeText),
  )(paramType.getProperties().length >= 2 && isEnvDepType(typeText));
};

const checkSigForReader = (target: TargetBinding) =>
  flow(
    O.fromPredicate(hasSingleCurriedParam),
    O.chain(getFirstParam),
    O.chain(checkParamSymbol(target)),
  );

const mkReaderCandidate = (b: BindingInfo) => (depType: string) => ({ b, depType });

const toReaderCandidate = (ctx: RuleContext) => (b: BindingInfo) =>
  flow(
    getBindingType(ctx),
    readCallSignatures,
    RA.head,
    O.chain(checkSigForReader({ context: ctx, binding: b })),
    O.map(mkReaderCandidate(b)),
  )(b);

const getCandidateName = (c: ReaderCandidate) => c.b.name;

const buildReaderThreadingHint =
  (candidates: ReadonlyArray<ReaderCandidate>) =>
  (first: ReaderCandidate): ReadonlyArray<AgentHint> =>
    B.match<ReadonlyArray<AgentHint>>(
      () => [],
      () => [
        {
          hintId: isoHintId.wrap('monad-reader-threading'),
          category: 'monad',
          priority: 'high',
          location: getBindingLocation(first.b),
          evidence: isoHintEvidence.wrap(`Dependency/config type (${first.depType}) is threaded across ${candidates.length} curried helpers (${RA.map(getCandidateName)(candidates).join(', ')}).`),
          suggestion: isoHintSuggestion.wrap('Lift shared dependency threading into `fp-ts/Reader` or `ReaderTaskEither` (`RTE.ask` / `RTE.asks`).'),
          suggestedSignature: O.some(`ReaderTaskEither<${first.depType}, Error, Result>`),
          researchQuestions: [
            'Do these helpers share the same environment/dependency record across the module?',
          ],
        },
      ],
    )(candidates.length >= 2);

const checkReaderThreading = (ctx: RuleContext) => {
  const candidates = RA.filterMap(toReaderCandidate(ctx))(getIrBindings(ctx));
  return O.match<ReaderCandidate, ReadonlyArray<AgentHint>>(
    () => [],
    buildReaderThreadingHint(candidates),
  )(RA.head(candidates));
};

const isArrayOfEffectSig = (ctx: RuleContext) => (sig: ts.Signature) =>
  sig.getReturnType().getCallSignatures().length === 0 &&
  /^(ReadonlyArray|Array)<.*(Option|Either|TaskEither|Task)</.test(
    renderType(ctx)(sig.getReturnType()),
  );

const checkBindingArrayOfEffects = (ctx: RuleContext) => (b: BindingInfo) => {
  const returnsArrayOfEffect = flow(
    getBindingType(ctx),
    readCallSignatures,
    RA.some(isArrayOfEffectSig(ctx)),
  )(b);

  return B.match<ReadonlyArray<AgentHint>>(
    () => [],
    () => [
      {
        hintId: isoHintId.wrap(`monad-traverse-${b.name}`),
        category: 'monad',
        priority: 'high',
        location: getBindingLocation(b),
        evidence: isoHintEvidence.wrap(`\`${b.name}\` produces an array of effects (${b.signature}).`),
        suggestion: isoHintSuggestion.wrap('Use `RA.traverse(Effect.Applicative)` or `RA.sequence` to invert `ReadonlyArray<Effect<A>>` into `Effect<ReadonlyArray<A>>`.'),
        suggestedSignature: O.none,
        researchQuestions: [
          'Should this collection transform fail-fast (`E.Applicative`) or accumulate errors (`E.getApplicativeValidation`)?',
        ],
      },
    ],
  )(returnsArrayOfEffect);
};

const checkArrayOfEffects = (ctx: RuleContext) =>
  RA.chain(checkBindingArrayOfEffects(ctx))(getIrBindings(ctx));

export const detectMonadLiftingHints = ((ctx: RuleContext): ReadonlyArray<AgentHint> => [
  ...checkReaderThreading(ctx),
  ...checkArrayOfEffects(ctx),
]) satisfies HintRunner;
