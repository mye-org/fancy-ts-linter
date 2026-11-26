import * as B from 'fp-ts/lib/boolean.js';
import * as M from 'fp-ts/lib/Monoid.js';
import * as Ord from 'fp-ts/lib/Ord.js';
import { sort as raSort } from 'fp-ts/lib/ReadonlyArray.js';
import * as S from 'fp-ts/lib/string.js';
import { constant, flow } from 'fp-ts/lib/function.js';
import * as N from 'fp-ts/lib/number.js';
import { iso } from 'newtype-ts';
import type * as ts from 'typescript';
import type {
  BuiltProjectDag,
  CrossFileHint,
  ModuleCount,
  OccurrenceCount,
  ResolvedAnalyzeOptions,
} from '../model/projectReport.js';
import type { HintId, HintPriority, TypeInspector } from '../model/report.js';
import { runDagSmellDetectors } from './dagSmells.js';
import { runPatternDiscoveryDetectors } from './patternDiscovery.js';

const isoHintId = iso<HintId>();
const isoModuleCount = iso<ModuleCount>();
const isoOccurrenceCount = iso<OccurrenceCount>();

export type RunAllCrossFileHintsInput = {
  readonly dag: BuiltProjectDag;
  readonly checker: ts.TypeChecker;
  readonly inspector: TypeInspector;
  readonly options: ResolvedAnalyzeOptions;
};

export type RunAllCrossFileHints = (
  input: RunAllCrossFileHintsInput,
) => ReadonlyArray<CrossFileHint>;

const priorityWeight = (p: HintPriority) => {
  const weights = { high: 0, medium: 1, low: 2 } as const;
  return weights[p];
};

const getHintPriority = (h: CrossFileHint) => h.priority;
const getHintCategory = (h: CrossFileHint) => h.category;
const getHintId = (h: CrossFileHint) => isoHintId.unwrap(h.hintId);

const ordByPriority = Ord.contramap(flow(getHintPriority, priorityWeight))(N.Ord);
const ordByCategory = Ord.contramap(getHintCategory)(S.Ord);
const ordByHintId = Ord.contramap(getHintId)(S.Ord);

const crossFileHintOrd = M.concatAll(Ord.getMonoid<CrossFileHint>())([
  ordByPriority,
  ordByCategory,
  ordByHintId,
]);

const sortHints = raSort(crossFileHintOrd);

const collectAllHints = ({
  dag,
  checker,
  inspector,
  options,
}: RunAllCrossFileHintsInput) =>
  sortHints([
    ...runDagSmellDetectors({
      dag,
      options: { minDirModules: isoModuleCount.unwrap(options.minDirModules) },
    }),
    ...runPatternDiscoveryDetectors({
      dag,
      checker,
      inspector,
      options: {
        minPatternOccurrences: isoOccurrenceCount.unwrap(options.minPatternOccurrences),
      },
    }),
  ]);

export const runAllCrossFileHints = ((input: RunAllCrossFileHintsInput) =>
  B.match(
    () => collectAllHints(input),
    constant<ReadonlyArray<CrossFileHint>>([]),
  )(input.dag.modules.size < 2)) satisfies RunAllCrossFileHints;
