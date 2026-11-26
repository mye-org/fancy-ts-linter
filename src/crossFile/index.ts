import type * as ts from 'typescript';
import type {
  BuiltProjectDag,
  CrossFileHint,
  ResolvedAnalyzeOptions,
} from '../model/projectReport.js';
import type { HintPriority, TypeInspector } from '../model/report.js';
import { runDagSmellDetectors } from './dagSmells.js';
import { runPatternDiscoveryDetectors } from './patternDiscovery.js';

const priorityWeight = (p: HintPriority): number =>
  p === 'high' ? 0 : p === 'medium' ? 1 : 2;

export const runAllCrossFileHints = (
  dag: BuiltProjectDag,
  checker: ts.TypeChecker,
  inspector: TypeInspector,
  options: ResolvedAnalyzeOptions,
): ReadonlyArray<CrossFileHint> => {
  if (dag.modules.size < 2) {
    return [];
  }

  const allHints: CrossFileHint[] = [
    ...runDagSmellDetectors(dag, { minDirModules: options.minDirModules }),
    ...runPatternDiscoveryDetectors(dag, checker, inspector, {
      minPatternOccurrences: options.minPatternOccurrences,
    }),
  ];

  return allHints.sort(
    (a, b) =>
      priorityWeight(a.priority) - priorityWeight(b.priority) ||
      a.category.localeCompare(b.category) ||
      a.hintId.localeCompare(b.hintId),
  );
};
