import { flow } from 'fp-ts/lib/function.js';
import * as Ord from 'fp-ts/lib/Ord.js';
import * as N from 'fp-ts/lib/number.js';
import * as RA from 'fp-ts/lib/ReadonlyArray.js';
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

const priorityWeight = (p: HintPriority) => {
  const weights: Record<HintPriority, number> = { high: 0, medium: 1, low: 2 };
  return weights[p];
};

const hintPriorityWeight = (h: AgentHint) => priorityWeight(h.priority);

const byPriority = Ord.contramap(hintPriorityWeight)(N.Ord);

const applyRunner = (ctx: RuleContext) => (r: HintRunner) => r(ctx);

const executeDetectors = (ctx: RuleContext) => {
  const runners: ReadonlyArray<HintRunner> = [
    detectAdtOverFlagsHints,
    detectNewtypeBrandHints,
    detectPatternMatchingDepthHints,
    detectDddAndArityHints,
    detectMonadLiftingHints,
    detectOpticsHints,
    detectDeclarativeCombinatorHints,
    detectInferenceHygieneHints,
  ];
  return RA.chain(applyRunner(ctx))(runners);
};

const sortHints = RA.sortBy([byPriority]);

export const runAllHints = flow(
  executeDetectors,
  sortHints,
) satisfies HintRunner;
