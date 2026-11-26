import type * as ts from 'typescript';
import type { BuiltProjectDag, CrossFileHint } from '../model/projectReport.js';
import type { TypeInspector } from '../model/report.js';
import { discoverArchitecturalMotifs } from './architecturalMotifDiscovery.js';
import { discoverEnvThreading } from './envThreadingDiscovery.js';
import { discoverGenericAbstractions } from './genericAbstractionDiscovery.js';
import { discoverMissingDomainModels } from './missingDomainModelDiscovery.js';
import { discoverPipelineMotifs } from './pipelineMotifDiscovery.js';

export type PatternDiscoveryOptions = {
  readonly minPatternOccurrences: number;
};

export type RunPatternDiscoveryInput = {
  readonly dag: BuiltProjectDag;
  readonly checker: ts.TypeChecker;
  readonly inspector: TypeInspector;
  readonly options: PatternDiscoveryOptions;
};

export const runPatternDiscoveryDetectors = (({
  dag,
  checker,
  inspector,
  options,
}: RunPatternDiscoveryInput): ReadonlyArray<CrossFileHint> => {
  const minOcc = options.minPatternOccurrences;
  return [
    ...discoverMissingDomainModels({ dag, checker, minOcc }),
    ...discoverPipelineMotifs({ dag, checker, inspector, minOcc }),
    ...discoverGenericAbstractions({ dag, checker, minOcc }),
    ...discoverEnvThreading({ dag, checker, minOcc }),
    ...discoverArchitecturalMotifs({ dag, checker, minOcc }),
  ];
}) satisfies (input: RunPatternDiscoveryInput) => ReadonlyArray<CrossFileHint>;
