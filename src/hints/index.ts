import { constant, flow } from 'fp-ts/lib/function.js';
import * as Ord from 'fp-ts/lib/Ord.js';
import * as N from 'fp-ts/lib/number.js';
import { chain as raChain, sort as raSort } from 'fp-ts/lib/ReadonlyArray.js';
import { match } from 'ts-pattern';
import type { AgentHint, HintPriority, RuleContext } from '../model/report.js';
import { detectAdtOverFlagsHints } from './adtOverFlagsHint.js';
import { detectNewtypeBrandHints } from './newtypeBrandHint.js';
import { detectPatternMatchingDepthHints } from './patternMatchingDepthHint.js';
import { detectDeclarativeCombinatorHints } from './declarativeCombinatorHint.js';
import { detectInferenceHygieneHints } from './inferenceHygieneHint.js';
import { detectMonadLiftingHints } from './monadLiftingHint.js';
import { detectOpticsHints } from './opticsHint.js';
import { detectDddAndArityHints } from './dddDecompositionAndArityHint.js';

export type HintRunner = (ctx: RuleContext) => ReadonlyArray<AgentHint>;

const priorityWeight = (p: HintPriority) =>
  match(p)
    .with('high', constant(0))
    .with('medium', constant(1))
    .with('low', constant(2))
    .exhaustive();

const getHintPriority = (h: AgentHint) => h.priority;

const byPriority = Ord.contramap(flow(getHintPriority, priorityWeight))(N.Ord);

const applyRunner = (ctx: RuleContext) => (r: HintRunner) => r(ctx);

const executeDetectors = (ctx: RuleContext) =>
  raChain(applyRunner(ctx))([
    detectAdtOverFlagsHints,
    detectNewtypeBrandHints,
    detectPatternMatchingDepthHints,
    detectDddAndArityHints,
    detectMonadLiftingHints,
    detectOpticsHints,
    detectDeclarativeCombinatorHints,
    detectInferenceHygieneHints,
  ]);

const sortHints = raSort(byPriority);

export const runAllHints = flow(
  executeDetectors,
  sortHints,
) satisfies HintRunner;
