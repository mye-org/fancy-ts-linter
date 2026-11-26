import * as B from 'fp-ts/lib/boolean.js';
import { iso } from 'newtype-ts';
import { constant } from 'fp-ts/lib/function.js';
import * as O from 'fp-ts/lib/Option.js';

import { fromNullable as liftNullable } from 'fp-ts/lib/Option.js';
import * as RA from 'fp-ts/lib/ReadonlyArray.js';
import * as RNEA from 'fp-ts/lib/ReadonlyNonEmptyArray.js';
import * as S from 'fp-ts/lib/string.js';
import * as ts from 'typescript';
import type {
  BuiltProjectDag,
  CrossFileHint,
  ResolvedModuleData,
  DirectoryPath,
  LayerIndex,
  ModuleCount,
  RelativePath,
} from '../model/projectReport.js';
import type { FilePath } from '../graph/toRelativePosixPath.js';
import type { HintId } from '../model/report.js';

const listDagModules = (dag: BuiltProjectDag) => Array.from(dag.modules.values());
const isoHintId = iso<HintId>();
const isoFilePath = iso<FilePath>();
const isoRelativePath = iso<RelativePath>();
const isoDirectoryPath = iso<DirectoryPath>();
const isoLayerIndex = iso<LayerIndex>();
const isoModuleCount = iso<ModuleCount>();
import type { BindingInfo } from '../model/report.js';

export type EnvThreadingInput = {
  readonly dag: BuiltProjectDag;
  readonly checker: ts.TypeChecker;
  readonly minOcc: number;
};

type SignalOccurrence = {
  readonly signal: string;
  readonly filePath: string;
};

type BfsState = {
  readonly queue: ReadonlyArray<string>;
  readonly visited: ReadonlySet<string>;
};

const sortStrings = RA.sortBy([S.Ord]);
const inSet = (set: ReadonlySet<string>) => (value: string) => set.has(value);
const notInSet = (set: ReadonlySet<string>) => (value: string) => !set.has(value);

const isEnvFieldName = (name: string) =>
  new Set([
    'db',
    'database',
    'repo',
    'repository',
    'logger',
    'log',
    'config',
    'cfg',
    'env',
    'ctx',
    'context',
    'client',
    'http',
    'httpClient',
    'clock',
    'cache',
    'mailer',
    'storage',
    'gateway',
    'deps',
    'dependencies',
    'tracer',
    'metrics',
  ]).has(name);

const isEnvTypeName = (name: string) =>
  /(?:Env|Deps|Dependencies|Context|Config|Client|Repository|Repo|Logger|Clock|Gateway|Service|Store|Adapter)$/.test(
    name,
  );

const isReaderEffect = (e: string) =>
  e === 'Reader' || e === 'ReaderTask' || e === 'ReaderTaskEither';

const isIoEffect = (e: string) =>
  e === 'Task' ||
  e === 'TaskEither' ||
  e === 'ReaderTask' ||
  e === 'ReaderTaskEither' ||
  e === 'IO';

const isEffectfulIo = RA.some(isIoEffect);

const isTargetModule = (mod: ResolvedModuleData) => mod.scope === 'target';
const getRelativePath = (mod: ResolvedModuleData) => isoRelativePath.unwrap(mod.relativePath);
const getExportedFn = (mod: ResolvedModuleData) => mod.exportedFunction;

const involvesAnyTarget = (dag: BuiltProjectDag) => (files: ReadonlyArray<string>) => {
  const targetFiles = new Set(
    RA.map(getRelativePath)(RA.filter(isTargetModule)(listDagModules(dag))),
  );
  return RA.some(inSet(targetFiles))(files);
};

const getSymbolName = (sym: ts.Symbol) => sym.getName();

const getTypeSymbolName = (t: ts.Type) =>
  O.getOrElse(constant(''))(
    O.map(getSymbolName)(
      RA.head(RA.compact([liftNullable(t.aliasSymbol), liftNullable(t.getSymbol())])),
    ),
  );

const isNamedPublicType = (name: string) => name.length > 0 && !name.startsWith('__');
const isExportedNonOtherBinding = (b: BindingInfo) => b.visibility === 'exported' && b.kind !== 'other';

const extractPropSignal =
  (input: { readonly checker: ts.TypeChecker; readonly declaration: ts.Node }) =>
  (prop: ts.Symbol): O.Option<string> => {
    const propName = prop.getName();
    const propType = input.checker.getTypeOfSymbolAtLocation(prop, input.declaration);
    const propTypeName = getTypeSymbolName(propType);
    return B.match(
      () => O.none,
      () =>
        O.some(
          B.match(
            () => `field:${propName}`,
            () => `type:${propTypeName}`,
          )(isNamedPublicType(propTypeName)),
        ),
    )(isEnvFieldName(propName) || isEnvTypeName(propTypeName));
  };

const singleElementHead = <A>(arr: ReadonlyArray<A>) =>
  B.match(
    () => O.none,
    () => RA.head(arr),
  )(arr.length === 1);

const extractSignalsFromParam =
  (input: { readonly checker: ts.TypeChecker; readonly declaration: ts.Node }) =>
  (p0: ts.Symbol) => {
    const p0Type = input.checker.getTypeOfSymbol(p0);
    const p0SymName = getTypeSymbolName(p0Type);
    const directSignal = B.match(
      () => [],
      () => [
        B.match(
          () => `param:${p0.getName()}`,
          () => `type:${p0SymName}`,
        )(isNamedPublicType(p0SymName)),
      ],
    )(isEnvFieldName(p0.getName()) || isEnvTypeName(p0SymName));
    const propSignals = RA.filterMap(extractPropSignal(input))(p0Type.getProperties());
    return RA.uniq(S.Eq)([...directSignal, ...propSignals]);
  };

const extractSignalsFromSig =
  (input: { readonly checker: ts.TypeChecker; readonly declaration: ts.Node }) =>
  (sig: ts.Signature) =>
    O.map(extractSignalsFromParam(input))(singleElementHead(sig.getParameters()));

const extractSignalsFromBinding =
  (checker: ts.TypeChecker) =>
  (primary: BindingInfo) =>
    O.getOrElse(constant<ReadonlyArray<string>>([]))(
      O.chain(extractSignalsFromSig({ checker, declaration: primary.declaration }))(
        singleElementHead(checker.getTypeAtLocation(primary.declaration).getCallSignatures()),
      ),
    );

const extractEnvSignals =
  (checker: ts.TypeChecker) =>
  (mod: ResolvedModuleData): ReadonlyArray<string> =>
    B.match(
      () =>
        O.match(
          constant<ReadonlyArray<string>>([]),
          extractSignalsFromBinding(checker),
        )(RA.findFirst(isExportedNonOtherBinding)(mod.ir.bindings)),
      () => [],
    )(RA.some(isReaderEffect)(mod.exportedEffects));

const isActiveModule = (mod: ResolvedModuleData) => mod.moduleKind === 'standard';

const toSignalOccurrence =
  (filePath: string) =>
  (signal: string): SignalOccurrence => ({ signal, filePath });

const collectModuleSignals =
  (checker: ts.TypeChecker) =>
  (mod: ResolvedModuleData) =>
    RA.map(toSignalOccurrence(isoFilePath.unwrap(mod.filePath)))(extractEnvSignals(checker)(mod));

const getSignalKey = (o: SignalOccurrence) => o.signal;
const getSignalFilePath = (o: SignalOccurrence) => o.filePath;

const getEdgeSet =
  (edgeMap: ReadonlyMap<string, ReadonlySet<string>>) =>
  (curr: string) =>
    Array.from(
      O.getOrElse(constant<ReadonlySet<string>>(new Set()))(
        liftNullable(edgeMap.get(curr)),
      ),
    );

const getNeighborsInSet =
  (input: { readonly dag: BuiltProjectDag; readonly fileSet: ReadonlySet<string> }) =>
  (curr: string) =>
    RA.filter(inSet(input.fileSet))([
      ...getEdgeSet(input.dag.runtimeOutEdges)(curr),
      ...getEdgeSet(input.dag.runtimeInEdges)(curr),
    ]);

const expandBfsNode =
  (input: {
    readonly dag: BuiltProjectDag;
    readonly fileSet: ReadonlySet<string>;
    readonly state: BfsState;
  }) =>
  (curr: string): readonly [string, BfsState] => {
    const unvisited = RA.filter(notInSet(input.state.visited))(
      getNeighborsInSet({ dag: input.dag, fileSet: input.fileSet })(curr),
    );
    const nextVisited = new Set([...input.state.visited, ...unvisited]);
    const nextQueue = [...input.state.queue.slice(1), ...unvisited];
    return [curr, { queue: nextQueue, visited: nextVisited }] as const;
  };

const stepBfsComponent =
  (input: { readonly dag: BuiltProjectDag; readonly fileSet: ReadonlySet<string> }) =>
  (state: BfsState): O.Option<readonly [string, BfsState]> =>
    O.map(expandBfsNode({ dag: input.dag, fileSet: input.fileSet, state }))(
      RA.head(state.queue),
    );

const buildComponentFromStart =
  (input: {
    readonly dag: BuiltProjectDag;
    readonly fileSet: ReadonlySet<string>;
    readonly remaining: ReadonlyArray<string>;
  }) =>
  (start: string): readonly [ReadonlyArray<string>, ReadonlyArray<string>] => {
    const initial: BfsState = { queue: [start], visited: new Set([start]) };
    const comp = RA.unfold(
      initial,
      stepBfsComponent({ dag: input.dag, fileSet: input.fileSet }),
    );
    const nextRemaining = RA.filter(notInSet(new Set(comp)))(input.remaining);
    return [comp, nextRemaining] as const;
  };

const stepConnectedComponent =
  (input: { readonly dag: BuiltProjectDag; readonly fileSet: ReadonlySet<string> }) =>
  (remaining: ReadonlyArray<string>): O.Option<readonly [ReadonlyArray<string>, ReadonlyArray<string>]> =>
    O.map(
      buildComponentFromStart({
        dag: input.dag,
        fileSet: input.fileSet,
        remaining,
      }),
    )(RA.head(remaining));

const findConnectedComponents = (input: {
  readonly dag: BuiltProjectDag;
  readonly files: ReadonlyArray<string>;
}) => {
  const sortedFiles = RA.uniq(S.Eq)(sortStrings(input.files));
  const fileSet = new Set(sortedFiles);
  return RA.unfold(sortedFiles, stepConnectedComponent({ dag: input.dag, fileSet }));
};

const lookupModule =
  (dag: BuiltProjectDag) =>
  (f: string) =>
    liftNullable(dag.modules.get(f));

const hasEffectfulIoMod = (m: ResolvedModuleData) => isEffectfulIo(m.exportedEffects);

const isFileEffectfulIo = (dag: BuiltProjectDag) => (f: string) =>
  O.exists(hasEffectfulIoMod)(lookupModule(dag)(f));

const lookupRelativePath = (dag: BuiltProjectDag) => (f: string) =>
  O.map(getRelativePath)(lookupModule(dag)(f));

const lookupExportedFn = (dag: BuiltProjectDag) => (f: string) =>
  O.chain(getExportedFn)(lookupModule(dag)(f));

const buildEnvThreadingHint = (input: {
  readonly dag: BuiltProjectDag;
  readonly signal: string;
  readonly comp: ReadonlyArray<string>;
  readonly relFiles: ReadonlyArray<string>;
}) => {
  const symbols = sortStrings(RA.filterMap(lookupExportedFn(input.dag))(input.comp));
  const hasAsync = RA.some(isFileEffectfulIo(input.dag))(input.comp);
  const monad = B.match(
    () => 'Reader<Env, A>',
    () => 'ReaderTaskEither<Env, Err, A>',
  )(hasAsync);
  const cleanSignal = input.signal.replace(/^(?:type|field|param):/, '');
  const sig = B.match(
    () => `export type DomainOp = (input: Input) => R.Reader<${cleanSignal}, Output>;`,
    () =>
      `export type DomainOp = (input: Input) => RTE.ReaderTaskEither<${cleanSignal}, DomainError, Output>;`,
  )(hasAsync);
  return {
    hintId: isoHintId.wrap(`environment-threading-${cleanSignal.replace(/[^a-zA-Z0-9_-]/g, '_')}`),
    category: 'environment-threading' as const,
    priority: 'high' as const,
    files: input.relFiles,
    symbols,
    evidence: `Dependency/environment "${cleanSignal}" is manually threaded across ${input.comp.length} connected modules in the call DAG (${input.relFiles.join(', ')}).`,
    suggestion: `Lift this call-chain subgraph into ${monad} so "${cleanSignal}" is injected once at the application boundary instead of threaded through every intermediate signature.`,
    suggestedSignature: O.some(sig),
    researchQuestions: [
      `Should "${cleanSignal}" become part of a shared Reader environment composed via ReaderTaskEither.ask / local?`,
    ],
  };
};

const checkTargetAndBuildHint = (input: {
  readonly dag: BuiltProjectDag;
  readonly signal: string;
  readonly comp: ReadonlyArray<string>;
}): O.Option<CrossFileHint> => {
  const relFiles = sortStrings(RA.filterMap(lookupRelativePath(input.dag))(input.comp));
  return B.match(
    () => O.none,
    () =>
      O.some(
        buildEnvThreadingHint({
          dag: input.dag,
          signal: input.signal,
          comp: input.comp,
          relFiles,
        }),
      ),
  )(involvesAnyTarget(input.dag)(relFiles));
};

const toEnvThreadingHint =
  (input: { readonly dag: BuiltProjectDag; readonly minOcc: number; readonly signal: string }) =>
  (comp: ReadonlyArray<string>): O.Option<CrossFileHint> =>
    B.match(
      () => O.none,
      () => checkTargetAndBuildHint({ dag: input.dag, signal: input.signal, comp }),
    )(comp.length >= input.minOcc);

const processSignalGroup =
  (input: { readonly dag: BuiltProjectDag; readonly minOcc: number }) =>
  (entry: readonly [string, RNEA.ReadonlyNonEmptyArray<SignalOccurrence>]) => {
    const [signal, occs] = entry;
    const files = RA.uniq(S.Eq)(RA.map(getSignalFilePath)(occs));
    return B.match(
      () => [],
      () =>
        RA.filterMap(
          toEnvThreadingHint({ dag: input.dag, minOcc: input.minOcc, signal }),
        )(findConnectedComponents({ dag: input.dag, files })),
    )(files.length >= input.minOcc);
  };

export const discoverEnvThreading = (({
  dag,
  checker,
  minOcc,
}: EnvThreadingInput): ReadonlyArray<CrossFileHint> => {
  const occurrences = RA.chain(collectModuleSignals(checker))(
    RA.filter(isActiveModule)(listDagModules(dag)),
  );
  const grouped = RNEA.groupBy(getSignalKey)(occurrences);
  return RA.chain(processSignalGroup({ dag, minOcc }))(Object.entries(grouped));
}) satisfies (input: EnvThreadingInput) => ReadonlyArray<CrossFileHint>;
