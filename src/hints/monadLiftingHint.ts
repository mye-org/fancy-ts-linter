import { flow } from 'fp-ts/lib/function.js';
import * as O from 'fp-ts/lib/Option.js';
import * as RA from 'fp-ts/lib/ReadonlyArray.js';
import { Lens } from 'monocle-ts';
import * as ts from 'typescript';
import type { AgentHint, BindingInfo, RuleContext } from '../model/report.js';

export type HintRunner = (ctx: RuleContext) => ReadonlyArray<AgentHint>;

type BindingCtx = {
  readonly ctx: RuleContext;
  readonly b: BindingInfo;
};

type ReaderCandidate = {
  readonly b: BindingInfo;
  readonly depType: string;
};

type FormattedParamType = {
  readonly paramType: ts.Type;
  readonly typeText: string;
};

const bindingsLens = Lens.fromPath<RuleContext>()(['ir', 'bindings']);
const bindingNameLens = Lens.fromPath<ReaderCandidate>()(['b', 'name']);
const bindingLineLens = Lens.fromPath<ReaderCandidate>()(['b', 'location', 'line']);
const bindingColumnLens = Lens.fromPath<ReaderCandidate>()(['b', 'location', 'column']);
const locLineLens = Lens.fromPath<BindingInfo>()(['location', 'line']);
const locColumnLens = Lens.fromPath<BindingInfo>()(['location', 'column']);

const getDeclType = ({ ctx: { checker }, b }: BindingCtx) => checker.getTypeAtLocation(b.declaration);
const getFirstSig = (t: ts.Type) => RA.head(t.getCallSignatures());
const isCurriedSingleParamSig = (sig: ts.Signature) =>
  sig.getParameters().length === 1 && sig.getReturnType().getCallSignatures().length > 0;
const getFirstParam = (sig: ts.Signature) => RA.head(sig.getParameters());
const getParamType =
  ({ ctx: { checker }, b }: BindingCtx) =>
  (param: ts.Symbol) =>
    checker.getTypeOfSymbolAtLocation(param, b.declaration);

const attachFormattedType =
  ({ inspector }: RuleContext) =>
  (paramType: ts.Type): FormattedParamType => ({
    paramType,
    typeText: inspector.formatType(paramType),
  });

const hasDepProperties = ({ paramType, typeText }: FormattedParamType) =>
  paramType.getProperties().length >= 2 && /config|env|deps|ctx|repo|client/i.test(typeText);

const getTypeText = ({ typeText }: FormattedParamType) => typeText;

const isReaderCandidate =
  (ctx: RuleContext) =>
  (b: BindingInfo) =>
    flow(
      getDeclType,
      getFirstSig,
      O.filter(isCurriedSingleParamSig),
      O.chain(getFirstParam),
      O.map(getParamType({ ctx, b })),
      O.map(attachFormattedType(ctx)),
      O.filter(hasDepProperties),
      O.map(getTypeText),
    )({ ctx, b });

const toCandidate =
  (b: BindingInfo) =>
  (depType: string): ReaderCandidate => ({ b, depType });

const matchReaderCandidate =
  (ctx: RuleContext) =>
  (b: BindingInfo) =>
    O.map(toCandidate(b))(isReaderCandidate(ctx)(b));

const hasMultipleCandidates = (cs: ReadonlyArray<ReaderCandidate>) => cs.length >= 2;

const makeReaderHint =
  (cs: ReadonlyArray<ReaderCandidate>) =>
  (first: ReaderCandidate): AgentHint => ({
    hintId: 'monad-reader-threading',
    category: 'monad',
    priority: 'medium',
    location: {
      line: bindingLineLens.get(first),
      column: bindingColumnLens.get(first),
    },
    evidence: `Dependency/config type (${first.depType}) is threaded across ${cs.length} curried helpers (${RA.map(bindingNameLens.get)(cs).join(', ')}).`,
    suggestion:
      'Lift shared dependency threading into `fp-ts/Reader` or `ReaderTaskEither` (`RTE.ask` / `RTE.asks`).',
    suggestedSignature: O.some(`ReaderTaskEither<${first.depType}, Error, Result>`),
    researchQuestions: [
      'Do these helpers share the same environment/dependency record across the module?',
    ],
  });

const toReaderHint = (cs: ReadonlyArray<ReaderCandidate>) =>
  O.map(makeReaderHint(cs))(RA.head(cs));

const checkReaderThreading = (ctx: RuleContext) =>
  flow(
    bindingsLens.get,
    RA.filterMap(matchReaderCandidate(ctx)),
    O.fromPredicate(hasMultipleCandidates),
    O.chain(toReaderHint),
    O.match(RA.zero<AgentHint>, RA.of),
  )(ctx);

const isArrayOfEffectSig =
  ({ inspector }: RuleContext) =>
  (sig: ts.Signature) =>
    /(ReadonlyArray|Array)<.*(Option|Either|TaskEither|Task)</.test(
      inspector.formatType(sig.getReturnType()),
    );

const hasArrayOfEffectReturn =
  (ctx: RuleContext) =>
  (b: BindingInfo) =>
    RA.some(isArrayOfEffectSig(ctx))(
      ctx.checker.getTypeAtLocation(b.declaration).getCallSignatures(),
    );

const toArrayOfEffectsHint = (b: BindingInfo) => ({
  hintId: `monad-traverse-${b.name}`,
  category: 'monad' as const,
  priority: 'medium' as const,
  location: { line: locLineLens.get(b), column: locColumnLens.get(b) },
  evidence: `\`${b.name}\` produces an array of effects (${b.signature}).`,
  suggestion:
    'Use `RA.traverse(Effect.Applicative)` or `RA.sequence` to invert `ReadonlyArray<Effect<A>>` into `Effect<ReadonlyArray<A>>`.',
  suggestedSignature: O.none,
  researchQuestions: [
    'Should this collection transform fail-fast (`E.Applicative`) or accumulate errors (`E.getApplicativeValidation`)?',
  ],
});

const checkArrayOfEffects = (ctx: RuleContext) =>
  flow(
    bindingsLens.get,
    RA.filter(hasArrayOfEffectReturn(ctx)),
    RA.map(toArrayOfEffectsHint),
  )(ctx);

const runMonadLifting = (ctx: RuleContext) => [
  ...checkReaderThreading(ctx),
  ...checkArrayOfEffects(ctx),
];

const identityCtx = (ctx: RuleContext) => ctx;

export const detectMonadLiftingHints = flow(
  identityCtx,
  runMonadLifting,
) satisfies HintRunner;


