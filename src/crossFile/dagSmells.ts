import * as O from 'fp-ts/lib/Option.js';
import type {
  BuiltProjectDag,
  CrossFileHint,
  DirectoryCohesionMetric,
  ResolvedModuleData,
} from '../model/projectReport.js';

export type DagSmellOptions = {
  readonly minDirModules: number;
};

const isAncestorDir = (ancestor: string, descendant: string): boolean => {
  if (ancestor === descendant) {
    return true;
  }
  if (ancestor === '.') {
    return true;
  }
  return descendant.startsWith(`${ancestor}/`);
};

const computeDirectoryLca = (dirs: ReadonlyArray<string>): string => {
  if (dirs.length === 0) {
    return '.';
  }
  const split = dirs.map((d) => (d === '.' ? [] : d.split('/')));
  const first = split[0]!;
  let prefixLen = first.length;
  for (let i = 1; i < split.length; i += 1) {
    const parts = split[i]!;
    let j = 0;
    while (j < prefixLen && j < parts.length && parts[j] === first[j]) {
      j += 1;
    }
    prefixLen = j;
  }
  return prefixLen === 0 ? '.' : first.slice(0, prefixLen).join('/');
};

const findCycleWitnessPath = (
  scc: ReadonlyArray<string>,
  outEdges: ReadonlyMap<string, ReadonlySet<string>>,
): ReadonlyArray<string> => {
  const sccSet = new Set(scc);
  const start = scc[0]!;
  const prev = new Map<string, string>();
  const queue: string[] = [];

  for (const next of outEdges.get(start) ?? []) {
    if (sccSet.has(next)) {
      if (next === start) {
        return [start, start];
      }
      prev.set(next, start);
      queue.push(next);
    }
  }

  while (queue.length > 0) {
    const curr = queue.shift()!;
    for (const next of outEdges.get(curr) ?? []) {
      if (!sccSet.has(next)) {
        continue;
      }
      if (next === start) {
        const pathNodes: string[] = [start];
        let cursor: string | undefined = curr;
        const rev: string[] = [];
        while (cursor !== undefined && cursor !== start) {
          rev.push(cursor);
          cursor = prev.get(cursor);
        }
        rev.reverse();
        pathNodes.push(...rev, start);
        return pathNodes;
      }
      if (!prev.has(next)) {
        prev.set(next, curr);
        queue.push(next);
      }
    }
  }

  return [...scc, start];
};

const detectDependencyCycles = (dag: BuiltProjectDag): ReadonlyArray<CrossFileHint> => {
  const hints: CrossFileHint[] = [];

  for (let i = 0; i < dag.cycles.length; i += 1) {
    const scc = dag.cycles[i]!;
    const involvesTarget = scc.some((f) => dag.modules.get(f)?.isTarget === true);
    if (!involvesTarget) {
      continue;
    }

    const sccSet = new Set(scc);
    let hasRuntimeEdgeInScc = false;
    for (const f of scc) {
      for (const next of dag.runtimeOutEdges.get(f) ?? []) {
        if (sccSet.has(next)) {
          hasRuntimeEdgeInScc = true;
          break;
        }
      }
      if (hasRuntimeEdgeInScc) {
        break;
      }
    }

    const witness = findCycleWitnessPath(
      scc,
      hasRuntimeEdgeInScc ? dag.runtimeOutEdges : dag.allOutEdges,
    );
    const relWitness = witness.map((f) => dag.modules.get(f)?.relativePath ?? f);
    const relFiles = scc.map((f) => dag.modules.get(f)?.relativePath ?? f);
    const symbols = scc
      .map((f) => dag.modules.get(f)?.exportedFunction)
      .filter((opt): opt is O.Some<string> => opt !== undefined && O.isSome(opt))
      .map((s) => s.value);

    hints.push({
      hintId: `dependency-cycle-${i + 1}`,
      category: 'dependency-cycle',
      priority: hasRuntimeEdgeInScc ? 'high' : 'medium',
      files: relFiles,
      symbols,
      evidence: `${hasRuntimeEdgeInScc ? 'Runtime' : 'Type-only'} circular module dependency breaks DAG acyclicity: ${relWitness.join(' -> ')}.`,
      suggestion: hasRuntimeEdgeInScc
        ? 'Break the cycle by extracting shared domain types into a leaf type module or inverting one edge via a Reader/callback dependency.'
        : 'Extract mutually referenced types into a dedicated leaf domain-types module so the module graph remains a strict DAG.',
      suggestedSignature: O.none,
      researchQuestions: [
        'Which shared domain types or contracts are causing these modules to depend on each other?',
        'Can one direction of this dependency be inverted via Reader<Env, A> or a pure shared domain model?',
      ],
    });
  }

  return hints;
};

const isPureHomogeneousPrimitiveLibrary = (
  dirMods: ReadonlyArray<ResolvedModuleData>,
  metric: DirectoryCohesionMetric,
): boolean => {
  if (metric.distinctExternalDeps.length > 0) {
    return false;
  }
  if (dirMods.some((m) => m.referencedDomainTypes.length > 0)) {
    return false;
  }
  const inputTags = new Set<string>();
  for (const m of dirMods) {
    if (O.isNone(m.primitiveInputKind)) {
      return false;
    }
    inputTags.add(m.primitiveInputKind.value);
  }
  return inputTags.size === 1;
};

const detectJunkDrawerDirectories = (
  dag: BuiltProjectDag,
  options: DagSmellOptions,
): ReadonlyArray<CrossFileHint> => {
  const hints: CrossFileHint[] = [];

  for (const metric of dag.directories) {
    if (metric.moduleCount < options.minDirModules) {
      continue;
    }

    const dirMods = Array.from(dag.modules.values()).filter(
      (m) => m.directory === metric.directory && !m.isBarrel && !m.isTypeOnlyModule,
    );

    const involvesTarget = dirMods.some((m) => m.isTarget);
    if (!involvesTarget) {
      continue;
    }

    // Protect cohesive pure leaf primitive libraries (e.g., strings/, math/)
    if (isPureHomogeneousPrimitiveLibrary(dirMods, metric)) {
      continue;
    }

    const isFragmented =
      metric.clusterCount >= Math.max(3, options.minDirModules) ||
      (metric.clusterCount >= 3 && metric.cohesionScore <= 0.35);

    if (!isFragmented || metric.averageCallerJaccard >= 0.25) {
      continue;
    }

    const clustersWithDeps = metric.clusters.filter((c) => c.sharedDependencies.length > 0).length;
    const clustersWithCallers = metric.clusters.filter((c) => c.callers.length > 0).length;

    const clusterDomainTypeSets = metric.clusters.map((cluster) => {
      const types = new Set<string>();
      for (const rel of cluster.modules) {
        const mod = dirMods.find((m) => m.relativePath === rel);
        if (mod !== undefined) {
          for (const t of mod.referencedDomainTypes) {
            types.add(t);
          }
        }
      }
      return types;
    });
    const clustersWithDomainTypes = clusterDomainTypeSets.filter((s) => s.size > 0).length;

    const singleCallerCount = dirMods.filter((m) => {
      const callers = Array.from(dag.runtimeInEdges.get(m.filePath) ?? []).filter(
        (c) => dag.modules.get(c)?.isBarrel !== true,
      );
      return callers.length === 1;
    }).length;

    // Require at least one concrete structural harm signal beyond just low internal edges
    const hasHeterogeneousDeps = clustersWithDeps >= 2 && metric.distinctExternalDeps.length >= 2;
    const hasMixedDomainTypes = clustersWithDomainTypes >= 2;
    const hasDisjointCallerIslands =
      clustersWithCallers >= 2 && metric.intraDirectoryEdges === 0;
    const hasPrematureSingleCallers = singleCallerCount >= 2;

    if (
      !hasHeterogeneousDeps &&
      !hasMixedDomainTypes &&
      !hasDisjointCallerIslands &&
      !hasPrematureSingleCallers
    ) {
      continue;
    }

    const clusterSummary = metric.clusters
      .slice(0, 5)
      .map((c, idx) => {
        const depsPart =
          c.sharedDependencies.length > 0 ? ` [deps: ${c.sharedDependencies.join(', ')}]` : '';
        const callersPart =
          c.callers.length > 0
            ? ` [callers: ${c.callers.slice(0, 3).join(', ')}${c.callers.length > 3 ? ', ...' : ''}]`
            : ' [no internal callers]';
        return `Cluster ${idx + 1} (${c.modules.join(', ')})${depsPart}${callersPart}`;
      })
      .join('; ');

    const symbols = dirMods
      .map((m) => m.exportedFunction)
      .filter(O.isSome)
      .map((s) => s.value);

    hints.push({
      hintId: `junk-drawer-directory-${metric.directory.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
      category: 'junk-drawer-directory',
      priority: hasHeterogeneousDeps || metric.clusterCount >= 4 ? 'high' : 'medium',
      files: dirMods.map((m) => m.relativePath).sort(),
      symbols,
      evidence: `Directory "${metric.directory}" behaves as a low-cohesion junk drawer (cohesion=${metric.cohesionScore}, ${metric.clusterCount} disconnected clusters across ${metric.moduleCount} modules, avg caller overlap=${metric.averageCallerJaccard}, intra-dir edges=${metric.intraDirectoryEdges}): ${clusterSummary}.`,
      suggestion:
        'Split this directory by domain/capability rather than keeping unrelated modules together: move single-caller modules next to their calling feature and group multi-caller modules by shared domain types or external adapters.',
      suggestedSignature: O.none,
      researchQuestions: [
        `Do the ${metric.clusterCount} disconnected clusters in "${metric.directory}" actually belong to distinct bounded contexts?`,
        'Which modules in this folder have only a single calling feature and can be co-located there?',
      ],
    });
  }

  return hints;
};

const detectMisplacedScope = (dag: BuiltProjectDag): ReadonlyArray<CrossFileHint> => {
  const hints: CrossFileHint[] = [];

  for (const mod of dag.modules.values()) {
    if (mod.isBarrel || mod.isTypeOnlyModule) {
      continue;
    }

    const nonBarrelCallers = Array.from(dag.runtimeInEdges.get(mod.filePath) ?? [])
      .map((c) => dag.modules.get(c))
      .filter((c): c is ResolvedModuleData => c !== undefined && !c.isBarrel);

    if (nonBarrelCallers.length === 0) {
      continue;
    }

    const involvesTarget = mod.isTarget || nonBarrelCallers.some((c) => c.isTarget);
    if (!involvesTarget) {
      continue;
    }

    // Also skip if re-exported by a root/public barrel (likely intentional public API)
    const isReExportedByBarrel = Array.from(dag.runtimeInEdges.get(mod.filePath) ?? []).some(
      (c) => dag.modules.get(c)?.isBarrel === true,
    );
    if (isReExportedByBarrel) {
      continue;
    }

    const callerDirs = nonBarrelCallers.map((c) => c.directory);
    const callerLcaDir = computeDirectoryLca(callerDirs);

    // Normal top-down decomposition: callers live at root or are an ancestor of mod.directory
    if (callerLcaDir === '.' || isAncestorDir(callerLcaDir, mod.directory)) {
      continue;
    }

    // If any caller is already in the same directory as mod, it's already co-located
    if (callerDirs.includes(mod.directory)) {
      continue;
    }

    const fnName = O.getOrElse(() => mod.relativePath)(mod.exportedFunction);
    const callerRelPaths = nonBarrelCallers.map((c) => c.relativePath).sort();

    if (nonBarrelCallers.length === 1) {
      const soleCaller = nonBarrelCallers[0]!;
      hints.push({
        hintId: `misplaced-scope-single-caller-${mod.relativePath.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
        category: 'misplaced-scope',
        priority: 'medium',
        files: [mod.relativePath, soleCaller.relativePath],
        symbols: [fnName],
        evidence: `Module "${mod.relativePath}" (in "${mod.directory}") is only called by a single module in another directory: "${soleCaller.relativePath}" (in "${soleCaller.directory}").`,
        suggestion: `Co-locate "${mod.relativePath}" inside "${soleCaller.directory}/" (or inline it as a private helper in "${soleCaller.relativePath}" if it has no independent domain reuse).`,
        suggestedSignature: O.none,
        researchQuestions: [
          `Is "${fnName}" genuinely a cross-cutting capability, or a premature abstraction only needed by "${soleCaller.directory}"?`,
        ],
      });
    } else {
      hints.push({
        hintId: `misplaced-scope-lca-${mod.relativePath.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
        category: 'misplaced-scope',
        priority: 'medium',
        files: [mod.relativePath, ...callerRelPaths],
        symbols: [fnName],
        evidence: `Module "${mod.relativePath}" lives in "${mod.directory}", but all ${nonBarrelCallers.length} callers (${callerRelPaths.join(', ')}) belong exclusively to subtree "${callerLcaDir}/".`,
        suggestion: `Move "${mod.relativePath}" down to its callers' lowest common ancestor directory "${callerLcaDir}/" to reduce global surface area and improve feature locality.`,
        suggestedSignature: O.none,
        researchQuestions: [
          `Should "${fnName}" belong to the "${callerLcaDir}" bounded context instead of "${mod.directory}"?`,
        ],
      });
    }
  }

  return hints;
};

const collectTransitiveDomainDeps = (
  startFile: string,
  dag: BuiltProjectDag,
): ReadonlySet<string> => {
  const deps = new Set<string>();
  const visited = new Set<string>([startFile]);
  const queue = [startFile];

  while (queue.length > 0) {
    const curr = queue.shift()!;
    const mod = dag.modules.get(curr);
    if (mod !== undefined) {
      for (const ext of mod.domainExternalDependencies) {
        deps.add(ext);
      }
    }
    for (const next of dag.runtimeOutEdges.get(curr) ?? []) {
      if (!visited.has(next)) {
        visited.add(next);
        queue.push(next);
      }
    }
  }

  return deps;
};

const detectHubBottlenecks = (dag: BuiltProjectDag): ReadonlyArray<CrossFileHint> => {
  const hints: CrossFileHint[] = [];

  for (const mod of dag.modules.values()) {
    if (mod.isBarrel || mod.isTypeOnlyModule) {
      continue;
    }
    const node = dag.nodeByFile.get(mod.filePath);
    if (node === undefined || node.isEntrypoint) {
      continue;
    }

    const callers = Array.from(dag.runtimeInEdges.get(mod.filePath) ?? [])
      .map((c) => dag.modules.get(c))
      .filter((c): c is ResolvedModuleData => c !== undefined && !c.isBarrel);

    const involvesTarget = mod.isTarget || callers.some((c) => c.isTarget);
    if (!involvesTarget || callers.length < 3) {
      continue;
    }

    const transitiveExtDeps = collectTransitiveDomainDeps(mod.filePath, dag);
    const outDirs = new Set<string>();
    for (const target of dag.runtimeOutEdges.get(mod.filePath) ?? []) {
      const targetMod = dag.modules.get(target);
      if (targetMod !== undefined && targetMod.directory !== mod.directory) {
        outDirs.add(targetMod.directory);
      }
    }

    const hasHeavyDirectDeps = mod.domainExternalDependencies.length >= 3;
    const hasHeavyTransitiveDeps = transitiveExtDeps.size >= 4;
    const hasWideCrossDirFanOut = outDirs.size >= 3 && node.transitiveDependencyCount >= 4;

    if (!hasHeavyDirectDeps && !hasHeavyTransitiveDeps && !hasWideCrossDirFanOut) {
      continue;
    }

    const fnName = O.getOrElse(() => mod.relativePath)(mod.exportedFunction);
    const extList = Array.from(transitiveExtDeps).sort();

    hints.push({
      hintId: `hub-bottleneck-${mod.relativePath.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
      category: 'hub-bottleneck',
      priority: hasHeavyDirectDeps || callers.length >= 5 ? 'high' : 'medium',
      files: [mod.relativePath, ...callers.map((c) => c.relativePath).sort()],
      symbols: [fnName],
      evidence: `Module "${mod.relativePath}" is a coupling hub with fan-in=${callers.length}, out-degree=${node.outDegree}, transitive dependencies=${node.transitiveDependencyCount}${extList.length > 0 ? `, pulling external packages [${extList.join(', ')}]` : ''}${outDirs.size > 0 ? ` across ${outDirs.size} directories (${Array.from(outDirs).sort().join(', ')})` : ''}.`,
      suggestion:
        'Decouple this hub by separating pure domain transformations (zero I/O fan-out) from external adapter integrations, or inject dependencies via Reader/ReaderTaskEither.',
      suggestedSignature: O.none,
      researchQuestions: [
        `Do all ${callers.length} callers of "${fnName}" actually need all transitive dependencies (${extList.join(', ') || 'internal sub-modules'})?`,
        'Can pure computation be split from I/O adapters to reduce transitive blast radius?',
      ],
    });
  }

  return hints;
};

export const runDagSmellDetectors = (
  dag: BuiltProjectDag,
  options: DagSmellOptions,
): ReadonlyArray<CrossFileHint> => [
  ...detectDependencyCycles(dag),
  ...detectJunkDrawerDirectories(dag, options),
  ...detectMisplacedScope(dag),
  ...detectHubBottlenecks(dag),
];
