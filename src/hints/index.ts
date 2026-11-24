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

const priorityWeight = (p: HintPriority): number =>
  p === 'high' ? 0 : p === 'medium' ? 1 : 2;

const byPriority: Ord.Ord<AgentHint> = Ord.contramap((h: AgentHint) => priorityWeight(h.priority))(
  N.Ord,
);

const executeDetectors = (ctx: RuleContext): ReadonlyArray<AgentHint> =>
  RA.chain((r: HintRunner) => r(ctx))(runners);

const sortHints = RA.sort(byPriority);

export const runAllHints = flow(
  executeDetectors,
  sortHints,
) satisfies HintRunner;
