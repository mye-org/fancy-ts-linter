import { flow } from 'fp-ts/lib/function.js';
import * as M from 'fp-ts/lib/Monoid.js';
import * as Ord from 'fp-ts/lib/Ord.js';
import * as N from 'fp-ts/lib/number.js';
import * as RA from 'fp-ts/lib/ReadonlyArray.js';
import * as S from 'fp-ts/lib/string.js';
import { iso } from 'newtype-ts';
import type { AgentHint, HintCategory, HintId, HintPriority, RuleContext } from '../model/report.js';
import { detectAdtOverFlagsHints } from './adtOverFlagsHint.js';
import { detectNewtypeBrandHints } from './newtypeBrandHint.js';
import { detectPatternMatchingDepthHints } from './patternMatchingDepthHint.js';
import { detectDeclarativeCombinatorHints } from './declarativeCombinatorHint.js';
import { detectInferenceHygieneHints } from './inferenceHygieneHint.js';
import { detectMonadLiftingHints } from './monadLiftingHint.js';
import { detectOpticsHints } from './opticsHint.js';
import { detectDddAndArityHints } from './dddDecompositionAndArityHint.js';

export type HintRunner = (ctx: RuleContext) => ReadonlyArray<AgentHint>;

const isoHintId = iso<HintId>();

const priorityWeight = (p: HintPriority) => {
  const weights: Record<HintPriority, number> = { high: 0, medium: 1, low: 2 };
  return weights[p];
};

const categoryWeight = (c: HintCategory) => {
  const weights: Record<HintCategory, number> = {
    'adt-over-flags': 0,
    'newtype-brand': 1,
    'ddd-decomposition': 2,
    'arity-strategy': 3,
    'pattern-matching-depth': 4,
    monad: 5,
    'declarative-combinator': 6,
    optic: 7,
    'inference-hygiene': 8,
  };
  return weights[c];
};

const hintPriorityWeight = (h: AgentHint) => priorityWeight(h.priority);
const hintCategoryWeight = (h: AgentHint) => categoryWeight(h.category);
const getHintId = (h: AgentHint) => isoHintId.unwrap(h.hintId);

const byPriority = Ord.contramap(hintPriorityWeight)(N.Ord);
const byCategory = Ord.contramap(hintCategoryWeight)(N.Ord);
const byHintId = Ord.contramap(getHintId)(S.Ord);

const hintOrd = M.concatAll(Ord.getMonoid<AgentHint>())([byPriority, byCategory, byHintId]);

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

const sortHints = RA.sort(hintOrd);

export const runAllHints = flow(
  executeDetectors,
  sortHints,
) satisfies HintRunner;
