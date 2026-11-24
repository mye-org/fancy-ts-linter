import { flow } from 'fp-ts/lib/function.js';
import * as O from 'fp-ts/lib/Option.js';
import * as RA from 'fp-ts/lib/ReadonlyArray.js';
import * as ts from 'typescript';
import type { AgentHint, BindingInfo, RuleContext } from '../model/report.js';

export type HintRunner = (ctx: RuleContext) => ReadonlyArray<AgentHint>;

const isReaderCandidate = (ctx: RuleContext) => (b: BindingInfo): O.Option<string> => {
  const t = ctx.checker.getTypeAtLocation(b.declaration);
  const sigs = t.getCallSignatures();
  if (sigs.length === 0) {
    return O.none;
  }
  const firstSig = sigs[0];
  if (firstSig === undefined) {
    return O.none;
  }
  const retSigs = firstSig.getReturnType().getCallSignatures();
  if (retSigs.length === 0 || firstSig.getParameters().length !== 1) {
    return O.none;
  }
  const param = firstSig.getParameters()[0];
  if (param === undefined) {
    return O.none;
  }
  const paramType = ctx.checker.getTypeOfSymbolAtLocation(param, b.declaration);
  const typeText = ctx.inspector.formatType(paramType);
  return paramType.getProperties().length >= 2 && /config|env|deps|ctx|repo|client/i.test(typeText)
    ? O.some(typeText)
    : O.none;
};

const checkReaderThreading = (ctx: RuleContext): ReadonlyArray<AgentHint> => {
  const candidates = RA.filterMap((b: BindingInfo) =>
    O.map((depType: string) => ({ b, depType }))(isReaderCandidate(ctx)(b)),
  )(ctx.ir.bindings);

  return candidates.length >= 2
    ? [
        {
          hintId: 'monad-reader-threading',
          category: 'monad',
          priority: 'medium',
          location: {
            line: candidates[0]!.b.location.line,
            column: candidates[0]!.b.location.column,
          },
          evidence: `Dependency/config type (${candidates[0]!.depType}) is threaded across ${candidates.length} curried helpers (${RA.map((c: { readonly b: BindingInfo }) => c.b.name)(candidates).join(', ')}).`,
          suggestion:
            'Lift shared dependency threading into `fp-ts/Reader` or `ReaderTaskEither` (`RTE.ask` / `RTE.asks`).',
          suggestedSignature: O.some(`ReaderTaskEither<${candidates[0]!.depType}, Error, Result>`),
          researchQuestions: [
            'Do these helpers share the same environment/dependency record across the module?',
          ],
        },
      ]
    : [];
};

const checkArrayOfEffects = (ctx: RuleContext): ReadonlyArray<AgentHint> =>
  RA.chain((b: BindingInfo): ReadonlyArray<AgentHint> => {
    const t = ctx.checker.getTypeAtLocation(b.declaration);
    const sigs = t.getCallSignatures();
    const returnsArrayOfEffect = RA.some((sig: ts.Signature) => {
      const retStr = ctx.inspector.formatType(sig.getReturnType());
      return /(ReadonlyArray|Array)<.*(Option|Either|TaskEither|Task)</.test(retStr);
    })(sigs);

    return returnsArrayOfEffect
      ? [
          {
            hintId: `monad-traverse-${b.name}`,
            category: 'monad',
            priority: 'medium',
            location: { line: b.location.line, column: b.location.column },
            evidence: `\`${b.name}\` produces an array of effects (${b.signature}).`,
            suggestion:
              'Use `RA.traverse(Effect.Applicative)` or `RA.sequence` to invert `ReadonlyArray<Effect<A>>` into `Effect<ReadonlyArray<A>>`.',
            suggestedSignature: O.none,
            researchQuestions: [
              'Should this collection transform fail-fast (`E.Applicative`) or accumulate errors (`E.getApplicativeValidation`)?',
            ],
          },
        ]
      : [];
  })(ctx.ir.bindings);

const runMonadLifting = (ctx: RuleContext): ReadonlyArray<AgentHint> => [
  ...checkReaderThreading(ctx),
  ...checkArrayOfEffects(ctx),
];

const identityCtx = (ctx: RuleContext) => ctx;

export const detectMonadLiftingHints = flow(
  identityCtx,
  runMonadLifting,
) satisfies HintRunner;
