import * as B from 'fp-ts/lib/boolean.js';
import * as O from 'fp-ts/lib/Option.js';
import * as RA from 'fp-ts/lib/ReadonlyArray.js';
import { reverse as raReverse, sort as raSort } from 'fp-ts/lib/ReadonlyArray.js';
import * as RM from 'fp-ts/lib/ReadonlyMap.js';
import * as S from 'fp-ts/lib/string.js';
import { constant } from 'fp-ts/lib/function.js';
import { Lens } from 'monocle-ts';
import type {
  BuiltProjectDag,
  CrossFileHint,
  DirectoryCluster,
  DirectoryCohesionMetric,
  ProjectModuleNode,
  ResolvedModuleData,
} from '../model/projectReport.js';

export type DagSmellOptions = {
  readonly minDirModules: number;
};

export type RunDagSmellDetectorsInput = {
  readonly dag: BuiltProjectDag;
  readonly options: DagSmellOptions;
};

export type RunDagSmellDetectors = (
  input: RunDagSmellDetectorsInput,
) => ReadonlyArray<CrossFileHint>;

type AncestorDirInput = {
  readonly ancestor: string;
  readonly descendant: string;
};

type CycleWitnessInput = {
  readonly scc: ReadonlyArray<string>;
  readonly outEdges: ReadonlyMap<string, ReadonlySet<string>>;
};

type PureHomogeneousInput = {
  readonly dirMods: ReadonlyArray<ResolvedModuleData>;
  readonly metric: DirectoryCohesionMetric;
};

type TransitiveDepsInput = {
  readonly startFile: string;
  readonly dag: BuiltProjectDag;
};

type BfsCycleState = {
  readonly queue: ReadonlyArray<string>;
  readonly prev: ReadonlyMap<string, string>;
  readonly visited: ReadonlySet<string>;
  readonly done: boolean;
};

type BfsCycleCtx = {
  readonly start: string;
  readonly sccSet: ReadonlySet<string>;
  readonly outEdges: ReadonlyMap<string, ReadonlySet<string>>;
};

type TransitiveDepsState = {
  readonly queue: ReadonlyArray<string>;
  readonly visited: ReadonlySet<string>;
};

const distinctExternalDepsLens = Lens.fromProp<DirectoryCohesionMetric>()('distinctExternalDeps');
const sharedDepsLens = Lens.fromProp<DirectoryCluster>()('sharedDependencies');
const callersLens = Lens.fromProp<DirectoryCluster>()('callers');

const isEqualString = (a: string) => (b: string) => a === b;
const isMemberOf = (set: ReadonlySet<string>) => (value: string) => set.has(value);
const isNotMemberOf = (set: ReadonlySet<string>) => (value: string) => !set.has(value);

const lookupModule =
  (modules: ReadonlyMap<string, ResolvedModuleData>) => (filePath: string) =>
    RM.lookup(S.Eq)(filePath)(modules);

const setToArray = (targets: ReadonlySet<string>) => Array.from(targets);

const getEdgeTargets =
  (edges: ReadonlyMap<string, ReadonlySet<string>>) =>
  (filePath: string): ReadonlyArray<string> =>
    O.match(constant<ReadonlyArray<string>>([]), setToArray)(RM.lookup(S.Eq)(filePath)(edges));

const sanitizeIdPart = (raw: string) => raw.replace(/[^a-zA-Z0-9_-]/g, '_');

const addSetEntries =
  (set: ReadonlySet<string>) =>
  (entries: ReadonlyArray<string>): ReadonlySet<string> =>
    new Set([...set, ...entries]);

const pairWithValue =
  (value: string) =>
  (key: string): readonly [string, string] => [key, value];

type AddPrevEntriesInput = {
  readonly prev: ReadonlyMap<string, string>;
  readonly parent: string;
  readonly children: ReadonlyArray<string>;
};

const addPrevEntries = ({
  prev,
  parent,
  children,
}: AddPrevEntriesInput) =>
  new Map([...prev, ...RA.map(pairWithValue(parent))(children)]);

const isAncestorDir = ({ ancestor, descendant }: AncestorDirInput) =>
  ancestor === descendant || ancestor === '.' || descendant.startsWith(`${ancestor}/`);

const splitBySlash = (d: string) => d.split('/');

const splitDirParts = (d: string) =>
  B.match(
    () => splitBySlash(d),
    constant<ReadonlyArray<string>>([]),
  )(d === '.');

type SegmentCheckCtx = {
  readonly idx: number;
  readonly seg: string;
};

const hasSegmentAt =
  ({ idx, seg }: SegmentCheckCtx) =>
  (parts: ReadonlyArray<string>) =>
    O.exists(isEqualString(seg))(RA.lookup(idx)(parts));

type LcpCheckCtx = {
  readonly split: ReadonlyArray<ReadonlyArray<string>>;
  readonly idx: number;
};

const checkAllMatchAt =
  ({ split, idx }: LcpCheckCtx) =>
  (seg: string): O.Option<readonly [string, number]> =>
    B.match(
      constant<O.Option<readonly [string, number]>>(O.none),
      constant<O.Option<readonly [string, number]>>(O.some([seg, idx + 1] as const)),
    )(RA.every(hasSegmentAt({ idx, seg }))(split));

const lcpUnfoldStep =
  (split: ReadonlyArray<ReadonlyArray<string>>) =>
  (idx: number): O.Option<readonly [string, number]> =>
    O.chain(checkAllMatchAt({ split, idx }))(O.chain(RA.lookup(idx))(RA.head(split)));

const joinPrefix = (prefix: ReadonlyArray<string>) =>
  B.match(
    () => prefix.join('/'),
    constant('.'),
  )(prefix.length === 0);

const computeNonEmptyLca = (dirs: ReadonlyArray<string>) =>
  joinPrefix(RA.unfold(0, lcpUnfoldStep(RA.map(splitDirParts)(dirs))));

const computeDirectoryLca = (dirs: ReadonlyArray<string>) =>
  B.match(
    () => computeNonEmptyLca(dirs),
    constant('.'),
  )(dirs.length === 0);

type ReconstructCtx = {
  readonly start: string;
  readonly prev: ReadonlyMap<string, string>;
};

const reconstructNodeStep =
  ({ start, prev }: ReconstructCtx) =>
  (node: string): O.Option<readonly [string, O.Option<string>]> =>
    B.match(
      constant<O.Option<readonly [string, O.Option<string>]>>(
        O.some([node, RM.lookup(S.Eq)(node)(prev)] as const),
      ),
      constant<O.Option<readonly [string, O.Option<string>]>>(O.none),
    )(node === start);

const reconstructStep = (ctx: ReconstructCtx) => O.chain(reconstructNodeStep(ctx));

type WitnessFromPrevInput = {
  readonly start: string;
  readonly curr: string;
  readonly prev: ReadonlyMap<string, string>;
};

const buildWitnessFromPrev = ({
  start,
  curr,
  prev,
}: WitnessFromPrevInput) => [
  start,
  ...raReverse(RA.unfold(O.some(curr), reconstructStep({ start, prev }))),
  start,
];

type BfsStepData = {
  readonly ctx: BfsCycleCtx;
  readonly state: BfsCycleState;
  readonly curr: string;
  readonly restQueue: ReadonlyArray<string>;
  readonly neighbors: ReadonlyArray<string>;
};

const advanceBfsQueue = ({
  state,
  curr,
  restQueue,
  neighbors,
}: BfsStepData) => {
  const emptyCycleMatch: O.Option<ReadonlyArray<string>> = O.none;
  const unvisited = RA.filter(isNotMemberOf(state.visited))(neighbors);
  const nextState: BfsCycleState = {
    queue: [...restQueue, ...unvisited],
    prev: addPrevEntries({ prev: state.prev, parent: curr, children: unvisited }),
    visited: addSetEntries(state.visited)(unvisited),
    done: false,
  };
  return [emptyCycleMatch, nextState] as const;
};

const finishBfsWithWitness = ({
  ctx,
  state,
  curr,
}: BfsStepData) => {
  const witness: ReadonlyArray<string> = buildWitnessFromPrev({
    start: ctx.start,
    curr,
    prev: state.prev,
  });
  const nextState: BfsCycleState = { ...state, done: true };
  return [O.some(witness), nextState] as const;
};

type BfsProcessCtx = {
  readonly ctx: BfsCycleCtx;
  readonly state: BfsCycleState;
};

const processBfsHead =
  ({ ctx, state }: BfsProcessCtx) =>
  (curr: string) => {
    const restQueue = RA.dropLeft(1)(state.queue);
    const neighbors = RA.filter(isMemberOf(ctx.sccSet))(getEdgeTargets(ctx.outEdges)(curr));
    const stepData: BfsStepData = { ctx, state, curr, restQueue, neighbors };
    return B.match(
      () => advanceBfsQueue(stepData),
      () => finishBfsWithWitness(stepData),
    )(neighbors.includes(ctx.start));
  };

const bfsCycleStep =
  (ctx: BfsCycleCtx) =>
  (state: BfsCycleState): O.Option<readonly [O.Option<ReadonlyArray<string>>, BfsCycleState]> =>
    B.match(
      () => O.map(processBfsHead({ ctx, state }))(RA.head(state.queue)),
      constant<O.Option<readonly [O.Option<ReadonlyArray<string>>, BfsCycleState]>>(O.none),
    )(state.done);

type BfsSearchInput = {
  readonly scc: ReadonlyArray<string>;
  readonly sccSet: ReadonlySet<string>;
  readonly outEdges: ReadonlyMap<string, ReadonlySet<string>>;
  readonly start: string;
  readonly initialNeighbors: ReadonlyArray<string>;
};

const runBfsSearch = ({
  scc,
  sccSet,
  outEdges,
  start,
  initialNeighbors,
}: BfsSearchInput) => {
  const initialState: BfsCycleState = {
    queue: initialNeighbors,
    prev: addPrevEntries({ prev: new Map(), parent: start, children: initialNeighbors }),
    visited: new Set([start, ...initialNeighbors]),
    done: false,
  };
  return O.getOrElse<ReadonlyArray<string>>(() => [...scc, start])(
    RA.head(RA.compact(RA.unfold(initialState, bfsCycleStep({ start, sccSet, outEdges })))),
  );
};

const searchCycleWitness =
  ({ scc, outEdges }: CycleWitnessInput) =>
  (start: string): ReadonlyArray<string> => {
    const sccSet = new Set(scc);
    const initialNeighbors = RA.filter(isMemberOf(sccSet))(getEdgeTargets(outEdges)(start));
    return B.match(
      () => runBfsSearch({ scc, sccSet, outEdges, start, initialNeighbors }),
      constant<ReadonlyArray<string>>([start, start]),
    )(initialNeighbors.includes(start));
  };

const findCycleWitnessPath = (input: CycleWitnessInput) =>
  O.match(
    constant<ReadonlyArray<string>>([]),
    searchCycleWitness(input),
  )(RA.head(input.scc));

const isModTarget = (m: ResolvedModuleData) => m.isTarget;
const getModRelativePath = (m: ResolvedModuleData) => m.relativePath;
const getModExportedFunction = (m: ResolvedModuleData) => m.exportedFunction;
const getModDirectory = (m: ResolvedModuleData) => m.directory;
const isBarrelMod = (m: ResolvedModuleData) => m.isBarrel;
const isNotBarrelMod = (m: ResolvedModuleData) => !m.isBarrel;
const isRuntimeMod = (m: ResolvedModuleData) => !m.isBarrel && !m.isTypeOnlyModule;

const isFileTarget =
  (modules: ReadonlyMap<string, ResolvedModuleData>) => (filePath: string) =>
    O.exists(isModTarget)(lookupModule(modules)(filePath));

type RuntimeEdgeCtx = {
  readonly runtimeOutEdges: ReadonlyMap<string, ReadonlySet<string>>;
  readonly sccSet: ReadonlySet<string>;
};

const hasRuntimeEdgeIntoScc =
  ({ runtimeOutEdges, sccSet }: RuntimeEdgeCtx) =>
  (filePath: string) =>
    RA.some(isMemberOf(sccSet))(getEdgeTargets(runtimeOutEdges)(filePath));

const resolveRelPath =
  (modules: ReadonlyMap<string, ResolvedModuleData>) => (filePath: string) =>
    O.match(constant(filePath), getModRelativePath)(lookupModule(modules)(filePath));

const resolveExportedFn =
  (modules: ReadonlyMap<string, ResolvedModuleData>) => (filePath: string) =>
    O.chain(getModExportedFunction)(lookupModule(modules)(filePath));

type BuildCycleHintInput = {
  readonly dag: BuiltProjectDag;
  readonly scc: ReadonlyArray<string>;
  readonly oneBasedIdx: number;
};

const createCycleHint = ({ dag, scc, oneBasedIdx }: BuildCycleHintInput): O.Option<CrossFileHint> => {
  const sccSet = new Set(scc);
  const hasRuntimeEdgeInScc = RA.some(
    hasRuntimeEdgeIntoScc({ runtimeOutEdges: dag.runtimeOutEdges, sccSet }),
  )(scc);
  const witness = findCycleWitnessPath({
    scc,
    outEdges: B.match(
      () => dag.allOutEdges,
      () => dag.runtimeOutEdges,
    )(hasRuntimeEdgeInScc),
  });
  const relWitness = RA.map(resolveRelPath(dag.modules))(witness);
  const relFiles = RA.map(resolveRelPath(dag.modules))(scc);
  const symbols = RA.filterMap(resolveExportedFn(dag.modules))(scc);
  const kindLabel = B.match(constant('Type-only'), constant('Runtime'))(hasRuntimeEdgeInScc);
  const priority = B.match(
    constant<'medium' | 'high'>('medium'),
    constant<'medium' | 'high'>('high'),
  )(hasRuntimeEdgeInScc);
  const suggestion = B.match(
    constant(
      'Extract mutually referenced types into a dedicated leaf domain-types module so the module graph remains a strict DAG.',
    ),
    constant(
      'Break the cycle by extracting shared domain types into a leaf type module or inverting one edge via a Reader/callback dependency.',
    ),
  )(hasRuntimeEdgeInScc);

  return O.some({
    hintId: `dependency-cycle-${oneBasedIdx}`,
    category: 'dependency-cycle',
    priority,
    files: relFiles,
    symbols,
    evidence: `${kindLabel} circular module dependency breaks DAG acyclicity: ${relWitness.join(' -> ')}.`,
    suggestion,
    suggestedSignature: O.none,
    researchQuestions: [
      'Which shared domain types or contracts are causing these modules to depend on each other?',
      'Can one direction of this dependency be inverted via Reader<Env, A> or a pure shared domain model?',
    ],
  });
};

const buildCycleHint =
  (dag: BuiltProjectDag) =>
  ([scc, oneBasedIdx]: readonly [ReadonlyArray<string>, number]): O.Option<CrossFileHint> =>
    B.match(
      constant<O.Option<CrossFileHint>>(O.none),
      () => createCycleHint({ dag, scc, oneBasedIdx }),
    )(RA.some(isFileTarget(dag.modules))(scc));

const detectDependencyCycles = (dag: BuiltProjectDag) =>
  B.match(
    () =>
      RA.filterMap(buildCycleHint(dag))(
        RA.zip(RA.range(1, dag.cycles.length))(dag.cycles),
      ),
    constant<ReadonlyArray<CrossFileHint>>([]),
  )(dag.cycles.length === 0);

const hasDomainTypes = (m: ResolvedModuleData) => m.referencedDomainTypes.length > 0;
const getModPrimitiveInputKind = (m: ResolvedModuleData) => m.primitiveInputKind;

const isPureHomogeneousPrimitiveLibrary = ({ dirMods, metric }: PureHomogeneousInput) => {
  const inputKinds = RA.filterMap(getModPrimitiveInputKind)(dirMods);
  return (
    distinctExternalDepsLens.get(metric).length === 0 &&
    !RA.some(hasDomainTypes)(dirMods) &&
    inputKinds.length === dirMods.length &&
    new Set(inputKinds).size === 1
  );
};

const isDirRuntimeModule = (directory: string) => (m: ResolvedModuleData) =>
  m.directory === directory && isRuntimeMod(m);

const clusterHasDeps = (c: DirectoryCluster) => sharedDepsLens.get(c).length > 0;
const clusterHasCallers = (c: DirectoryCluster) => callersLens.get(c).length > 0;

const findByRelativePath = (rel: string) => (m: ResolvedModuleData) => m.relativePath === rel;

const getModDomainTypes = (m: ResolvedModuleData) => m.referencedDomainTypes;

const lookupDomainTypesByRel =
  (dirMods: ReadonlyArray<ResolvedModuleData>) => (rel: string) =>
    O.match(
      constant<ReadonlyArray<string>>([]),
      getModDomainTypes,
    )(RA.findFirst(findByRelativePath(rel))(dirMods));

const getClusterDomainTypes =
  (dirMods: ReadonlyArray<ResolvedModuleData>) => (cluster: DirectoryCluster) =>
    new Set(RA.chain(lookupDomainTypesByRel(dirMods))(cluster.modules));

const isNonEmptySet = (s: ReadonlySet<string>) => s.size > 0;

const hasSingleNonBarrelCaller =
  (dag: BuiltProjectDag) => (m: ResolvedModuleData) =>
    RA.filter(isNotBarrelMod)(
      RA.filterMap(lookupModule(dag.modules))(getEdgeTargets(dag.runtimeInEdges)(m.filePath)),
    ).length === 1;

const formatCallersPart = (callers: ReadonlyArray<string>) => {
  const ellipsis = B.match(constant(''), constant(', ...'))(callers.length > 3);
  return ` [callers: ${RA.takeLeft(3)(callers).join(', ')}${ellipsis}]`;
};

const formatClusterSummary = ([c, oneBasedIdx]: readonly [DirectoryCluster, number]) => {
  const deps = sharedDepsLens.get(c);
  const callers = callersLens.get(c);
  const depsPart = B.match(
    constant(''),
    () => ` [deps: ${deps.join(', ')}]`,
  )(deps.length > 0);
  const callersPart = B.match(
    constant(' [no internal callers]'),
    () => formatCallersPart(callers),
  )(callers.length > 0);
  return `Cluster ${oneBasedIdx} (${c.modules.join(', ')})${depsPart}${callersPart}`;
};

const formatClustersSummary = (clusters: ReadonlyArray<DirectoryCluster>) => {
  const top = RA.takeLeft(5)(clusters);
  return B.match(
    () => RA.map(formatClusterSummary)(RA.zip(RA.range(1, top.length))(top)).join('; '),
    constant(''),
  )(top.length === 0);
};

type JunkDrawerPayloadInput = {
  readonly metric: DirectoryCohesionMetric;
  readonly dirMods: ReadonlyArray<ResolvedModuleData>;
  readonly hasHeterogeneousDeps: boolean;
};

const createJunkDrawerHint = ({
  metric,
  dirMods,
  hasHeterogeneousDeps,
}: JunkDrawerPayloadInput): O.Option<CrossFileHint> => {
  const clusterSummary = formatClustersSummary(metric.clusters);
  const symbols = RA.filterMap(getModExportedFunction)(dirMods);
  const priority = B.match(
    constant<'medium' | 'high'>('medium'),
    constant<'medium' | 'high'>('high'),
  )(hasHeterogeneousDeps || metric.clusterCount >= 4);

  return O.some({
    hintId: `junk-drawer-directory-${sanitizeIdPart(metric.directory)}`,
    category: 'junk-drawer-directory',
    priority,
    files: raSort(S.Ord)(RA.map(getModRelativePath)(dirMods)),
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
};

type EvaluateJunkDrawerInput = {
  readonly dag: BuiltProjectDag;
  readonly metric: DirectoryCohesionMetric;
  readonly dirMods: ReadonlyArray<ResolvedModuleData>;
};

const evaluateJunkDrawerSignals = ({
  dag,
  metric,
  dirMods,
}: EvaluateJunkDrawerInput): O.Option<CrossFileHint> => {
  const clustersWithDeps = RA.filter(clusterHasDeps)(metric.clusters).length;
  const clustersWithCallers = RA.filter(clusterHasCallers)(metric.clusters).length;
  const clustersWithDomainTypes = RA.filter(isNonEmptySet)(
    RA.map(getClusterDomainTypes(dirMods))(metric.clusters),
  ).length;
  const singleCallerCount = RA.filter(hasSingleNonBarrelCaller(dag))(dirMods).length;

  const hasHeterogeneousDeps =
    clustersWithDeps >= 2 && distinctExternalDepsLens.get(metric).length >= 2;
  const hasMixedDomainTypes = clustersWithDomainTypes >= 2;
  const hasDisjointCallerIslands =
    clustersWithCallers >= 2 && metric.intraDirectoryEdges === 0;
  const hasPrematureSingleCallers = singleCallerCount >= 2;
  const hasStructuralHarm =
    hasHeterogeneousDeps ||
    hasMixedDomainTypes ||
    hasDisjointCallerIslands ||
    hasPrematureSingleCallers;

  return B.match(
    constant<O.Option<CrossFileHint>>(O.none),
    () => createJunkDrawerHint({ metric, dirMods, hasHeterogeneousDeps }),
  )(hasStructuralHarm);
};

const buildJunkDrawerHint =
  ({ dag, options }: RunDagSmellDetectorsInput) =>
  (metric: DirectoryCohesionMetric): O.Option<CrossFileHint> => {
    const dirMods = RA.filter(isDirRuntimeModule(metric.directory))(
      Array.from(dag.modules.values()),
    );
    const involvesTarget = RA.some(isModTarget)(dirMods);
    const isFragmented =
      metric.clusterCount >= Math.max(3, options.minDirModules) ||
      (metric.clusterCount >= 3 && metric.cohesionScore <= 0.35);
    const shouldInspect =
      metric.moduleCount >= options.minDirModules &&
      involvesTarget &&
      !isPureHomogeneousPrimitiveLibrary({ dirMods, metric }) &&
      isFragmented &&
      metric.averageCallerJaccard < 0.25;

    return B.match(
      constant<O.Option<CrossFileHint>>(O.none),
      () => evaluateJunkDrawerSignals({ dag, metric, dirMods }),
    )(shouldInspect);
  };

const detectJunkDrawerDirectories = (input: RunDagSmellDetectorsInput) =>
  RA.filterMap(buildJunkDrawerHint(input))(input.dag.directories);

type MisplacedScopeHintInput = {
  readonly mod: ResolvedModuleData;
  readonly nonBarrelCallers: ReadonlyArray<ResolvedModuleData>;
  readonly callerLcaDir: string;
  readonly fnName: string;
  readonly callerRelPaths: ReadonlyArray<string>;
};

const buildSingleCallerMisplacedHint =
  ({ mod, fnName }: MisplacedScopeHintInput) =>
  (soleCaller: ResolvedModuleData): CrossFileHint => ({
    hintId: `misplaced-scope-single-caller-${sanitizeIdPart(mod.relativePath)}`,
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

const buildLcaMisplacedHint = ({
  mod,
  nonBarrelCallers,
  callerLcaDir,
  fnName,
  callerRelPaths,
}: MisplacedScopeHintInput) => ({
  hintId: `misplaced-scope-lca-${sanitizeIdPart(mod.relativePath)}`,
  category: 'misplaced-scope' as const,
  priority: 'medium' as const,
  files: [mod.relativePath, ...callerRelPaths],
  symbols: [fnName],
  evidence: `Module "${mod.relativePath}" lives in "${mod.directory}", but all ${nonBarrelCallers.length} callers (${callerRelPaths.join(', ')}) belong exclusively to subtree "${callerLcaDir}/".`,
  suggestion: `Move "${mod.relativePath}" down to its callers' lowest common ancestor directory "${callerLcaDir}/" to reduce global surface area and improve feature locality.`,
  suggestedSignature: O.none,
  researchQuestions: [
    `Should "${fnName}" belong to the "${callerLcaDir}" bounded context instead of "${mod.directory}"?`,
  ],
});

type CreateMisplacedInput = {
  readonly mod: ResolvedModuleData;
  readonly nonBarrelCallers: ReadonlyArray<ResolvedModuleData>;
  readonly callerLcaDir: string;
};

const createMisplacedScopeHint = ({
  mod,
  nonBarrelCallers,
  callerLcaDir,
}: CreateMisplacedInput): O.Option<CrossFileHint> => {
  const fnName = O.getOrElse(() => mod.relativePath)(mod.exportedFunction);
  const callerRelPaths = raSort(S.Ord)(RA.map(getModRelativePath)(nonBarrelCallers));
  const hintInput: MisplacedScopeHintInput = {
    mod,
    nonBarrelCallers,
    callerLcaDir,
    fnName,
    callerRelPaths,
  };
  return B.match(
    () => O.some(buildLcaMisplacedHint(hintInput)),
    () => O.map(buildSingleCallerMisplacedHint(hintInput))(RA.head(nonBarrelCallers)),
  )(nonBarrelCallers.length === 1);
};

const buildMisplacedScopeHint =
  (dag: BuiltProjectDag) =>
  (mod: ResolvedModuleData): O.Option<CrossFileHint> => {
    const inModules = RA.filterMap(lookupModule(dag.modules))(
      getEdgeTargets(dag.runtimeInEdges)(mod.filePath),
    );
    const nonBarrelCallers = RA.filter(isNotBarrelMod)(inModules);
    const isReExportedByBarrel = RA.some(isBarrelMod)(inModules);
    const involvesTarget = mod.isTarget || RA.some(isModTarget)(nonBarrelCallers);
    const callerDirs = RA.map(getModDirectory)(nonBarrelCallers);
    const callerLcaDir = computeDirectoryLca(callerDirs);

    const isMisplaced =
      isRuntimeMod(mod) &&
      nonBarrelCallers.length > 0 &&
      involvesTarget &&
      !isReExportedByBarrel &&
      callerLcaDir !== '.' &&
      !isAncestorDir({ ancestor: callerLcaDir, descendant: mod.directory }) &&
      !callerDirs.includes(mod.directory);

    return B.match(
      constant<O.Option<CrossFileHint>>(O.none),
      () => createMisplacedScopeHint({ mod, nonBarrelCallers, callerLcaDir }),
    )(isMisplaced);
  };

const detectMisplacedScope = (dag: BuiltProjectDag) =>
  RA.filterMap(buildMisplacedScopeHint(dag))(Array.from(dag.modules.values()));

const getDomainExternalDeps = (m: ResolvedModuleData) => m.domainExternalDependencies;

type TransitiveStepCtx = {
  readonly dag: BuiltProjectDag;
  readonly state: TransitiveDepsState;
};

const processTransitiveNode =
  ({ dag, state }: TransitiveStepCtx) =>
  (curr: string): readonly [ReadonlyArray<string>, TransitiveDepsState] => {
    const deps = O.match(
      constant<ReadonlyArray<string>>([]),
      getDomainExternalDeps,
    )(lookupModule(dag.modules)(curr));
    const unvisited = RA.filter(isNotMemberOf(state.visited))(
      getEdgeTargets(dag.runtimeOutEdges)(curr),
    );
    const nextState: TransitiveDepsState = {
      queue: [...RA.dropLeft(1)(state.queue), ...unvisited],
      visited: addSetEntries(state.visited)(unvisited),
    };
    return [deps, nextState] as const;
  };

const transitiveDepsStep =
  (dag: BuiltProjectDag) =>
  (state: TransitiveDepsState): O.Option<readonly [ReadonlyArray<string>, TransitiveDepsState]> =>
    O.map(processTransitiveNode({ dag, state }))(RA.head(state.queue));

const collectTransitiveDomainDeps = ({ startFile, dag }: TransitiveDepsInput) =>
  new Set(
    RA.flatten(
      RA.unfold(
        { queue: [startFile], visited: new Set([startFile]) } satisfies TransitiveDepsState,
        transitiveDepsStep(dag),
      ),
    ),
  );

const checkDifferentDir =
  (currentDir: string) =>
  (targetMod: ResolvedModuleData): O.Option<string> =>
    B.match(
      constant<O.Option<string>>(O.none),
      constant<O.Option<string>>(O.some(targetMod.directory)),
    )(targetMod.directory !== currentDir);

type OutDirCtx = {
  readonly currentDir: string;
  readonly modules: ReadonlyMap<string, ResolvedModuleData>;
};

const getOutDirectoryIfDifferent =
  ({ currentDir, modules }: OutDirCtx) =>
  (targetFile: string) =>
    O.chain(checkDifferentDir(currentDir))(lookupModule(modules)(targetFile));

type HubPayloadInput = {
  readonly mod: ResolvedModuleData;
  readonly node: ProjectModuleNode;
  readonly callers: ReadonlyArray<ResolvedModuleData>;
  readonly transitiveExtDeps: ReadonlySet<string>;
  readonly outDirs: ReadonlySet<string>;
  readonly hasHeavyDirectDeps: boolean;
};

const createHubBottleneckHint = ({
  mod,
  node,
  callers,
  transitiveExtDeps,
  outDirs,
  hasHeavyDirectDeps,
}: HubPayloadInput): O.Option<CrossFileHint> => {
  const fnName = O.getOrElse(() => mod.relativePath)(mod.exportedFunction);
  const extList = raSort(S.Ord)(Array.from(transitiveExtDeps));
  const outDirList = raSort(S.Ord)(Array.from(outDirs));
  const extPart = B.match(
    constant(''),
    () => `, pulling external packages [${extList.join(', ')}]`,
  )(extList.length > 0);
  const outDirsPart = B.match(
    constant(''),
    () => ` across ${outDirs.size} directories (${outDirList.join(', ')})`,
  )(outDirs.size > 0);
  const priority = B.match(
    constant<'medium' | 'high'>('medium'),
    constant<'medium' | 'high'>('high'),
  )(hasHeavyDirectDeps || callers.length >= 5);
  const depsSummary = B.match(
    constant('internal sub-modules'),
    () => extList.join(', '),
  )(extList.length > 0);

  return O.some({
    hintId: `hub-bottleneck-${sanitizeIdPart(mod.relativePath)}`,
    category: 'hub-bottleneck',
    priority,
    files: [mod.relativePath, ...raSort(S.Ord)(RA.map(getModRelativePath)(callers))],
    symbols: [fnName],
    evidence: `Module "${mod.relativePath}" is a coupling hub with fan-in=${callers.length}, out-degree=${node.outDegree}, transitive dependencies=${node.transitiveDependencyCount}${extPart}${outDirsPart}.`,
    suggestion:
      'Decouple this hub by separating pure domain transformations (zero I/O fan-out) from external adapter integrations, or inject dependencies via Reader/ReaderTaskEither.',
    suggestedSignature: O.none,
    researchQuestions: [
      `Do all ${callers.length} callers of "${fnName}" actually need all transitive dependencies (${depsSummary})?`,
      'Can pure computation be split from I/O adapters to reduce transitive blast radius?',
    ],
  });
};

type EvaluateHubInput = {
  readonly dag: BuiltProjectDag;
  readonly mod: ResolvedModuleData;
  readonly node: ProjectModuleNode;
  readonly callers: ReadonlyArray<ResolvedModuleData>;
};

const evaluateHubBottleneck = ({
  dag,
  mod,
  node,
  callers,
}: EvaluateHubInput): O.Option<CrossFileHint> => {
  const transitiveExtDeps = collectTransitiveDomainDeps({
    startFile: mod.filePath,
    dag,
  });
  const outDirs = new Set(
    RA.filterMap(getOutDirectoryIfDifferent({ currentDir: mod.directory, modules: dag.modules }))(
      getEdgeTargets(dag.runtimeOutEdges)(mod.filePath),
    ),
  );
  const hasHeavyDirectDeps = mod.domainExternalDependencies.length >= 3;
  const hasHeavyTransitiveDeps = transitiveExtDeps.size >= 4;
  const hasWideCrossDirFanOut = outDirs.size >= 3 && node.transitiveDependencyCount >= 4;
  const isBottleneck =
    hasHeavyDirectDeps || hasHeavyTransitiveDeps || hasWideCrossDirFanOut;

  return B.match(
    constant<O.Option<CrossFileHint>>(O.none),
    () =>
      createHubBottleneckHint({
        mod,
        node,
        callers,
        transitiveExtDeps,
        outDirs,
        hasHeavyDirectDeps,
      }),
  )(isBottleneck);
};

type HubCandidateCtx = {
  readonly dag: BuiltProjectDag;
  readonly mod: ResolvedModuleData;
  readonly callers: ReadonlyArray<ResolvedModuleData>;
  readonly involvesTarget: boolean;
};

const checkHubCandidate =
  ({ dag, mod, callers, involvesTarget }: HubCandidateCtx) =>
  (node: ProjectModuleNode): O.Option<CrossFileHint> => {
    const isCandidate =
      isRuntimeMod(mod) && !node.isEntrypoint && involvesTarget && callers.length >= 3;
    return B.match(
      constant<O.Option<CrossFileHint>>(O.none),
      () => evaluateHubBottleneck({ dag, mod, node, callers }),
    )(isCandidate);
  };

const buildHubBottleneckHint =
  (dag: BuiltProjectDag) =>
  (mod: ResolvedModuleData): O.Option<CrossFileHint> => {
    const nodeOpt = RM.lookup(S.Eq)(mod.filePath)(dag.nodeByFile);
    const callers = RA.filter(isNotBarrelMod)(
      RA.filterMap(lookupModule(dag.modules))(getEdgeTargets(dag.runtimeInEdges)(mod.filePath)),
    );
    const involvesTarget = mod.isTarget || RA.some(isModTarget)(callers);

    return O.chain(checkHubCandidate({ dag, mod, callers, involvesTarget }))(nodeOpt);
  };

const detectHubBottlenecks = (dag: BuiltProjectDag) =>
  RA.filterMap(buildHubBottleneckHint(dag))(Array.from(dag.modules.values()));

export const runDagSmellDetectors = (({ dag, options }: RunDagSmellDetectorsInput) => [
  ...detectDependencyCycles(dag),
  ...detectJunkDrawerDirectories({ dag, options }),
  ...detectMisplacedScope(dag),
  ...detectHubBottlenecks(dag),
]) satisfies RunDagSmellDetectors;
