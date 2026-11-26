import * as B from 'fp-ts/lib/boolean.js';
import { constant } from 'fp-ts/lib/function.js';
import * as O from 'fp-ts/lib/Option.js';
import * as RA from 'fp-ts/lib/ReadonlyArray.js';
import * as RNEA from 'fp-ts/lib/ReadonlyNonEmptyArray.js';
import * as S from 'fp-ts/lib/string.js';
import * as ts from 'typescript';
import type {
  BuiltProjectDag,
  CrossFileHint,
  ProjectModuleNode,
  ResolvedModuleData,
} from '../model/projectReport.js';
import type { ImportInfo } from '../model/report.js';

export type ArchitecturalMotifInput = {
  readonly dag: BuiltProjectDag;
  readonly checker: ts.TypeChecker;
  readonly minOcc: number;
};

type StrategyEntry = {
  readonly sig: string;
  readonly mod: ResolvedModuleData;
};

type LeakyEdge = {
  readonly caller: ResolvedModuleData;
  readonly callee: ResolvedModuleData;
};

type IoBfsState = {
  readonly queue: ReadonlyArray<string>;
  readonly visited: ReadonlySet<string>;
};

type PropChainStep = {
  readonly name: string;
  readonly base: ts.Expression;
};

type OpticOccurrence = {
  readonly key: string;
  readonly rootType: string;
  readonly pathParts: ReadonlyArray<string>;
  readonly file: string;
};

const sortStrings = RA.sortBy([S.Ord]);
const identityNum = (i: number) => i;
const inSet = (set: ReadonlySet<string>) => (value: string) => set.has(value);

const lookupReversedIndex =
  (arr: ReadonlyArray<string>) =>
  (i: number) =>
    RA.lookup(arr.length - 1 - i)(arr);

const reverseStrings = (arr: ReadonlyArray<string>) =>
  RA.filterMap(lookupReversedIndex(arr))(RA.makeBy(arr.length, identityNum));

const isPrimitiveOrStdType = (name: string) =>
  new Set([
    'string',
    'number',
    'boolean',
    'bigint',
    'symbol',
    'unknown',
    'never',
    'void',
    'null',
    'undefined',
    'Date',
    'RegExp',
    'Error',
    'Array',
    'ReadonlyArray',
    'Record',
    'Map',
    'Set',
    'Option',
    'Either',
    'Task',
    'TaskEither',
    'Reader',
    'ReaderTask',
    'ReaderTaskEither',
    'IO',
    'State',
    'Promise',
    'Newtype',
  ]).has(name);

const normalizeTypeText = (raw: string) =>
  raw.replace(/\s+/g, ' ').replace(/\breadonly\s+/g, '').trim();

const isIoEffect = (e: string) =>
  e === 'Task' ||
  e === 'TaskEither' ||
  e === 'ReaderTask' ||
  e === 'ReaderTaskEither' ||
  e === 'IO';

const isEffectfulIo = RA.some(isIoEffect);

const isTargetModule = (mod: ResolvedModuleData) => mod.isTarget;
const getRelativePath = (mod: ResolvedModuleData) => mod.relativePath;
const getFilePath = (mod: ResolvedModuleData) => mod.filePath;
const isNonBarrel = (mod: ResolvedModuleData) => !mod.isBarrel;
const isActiveModule = (mod: ResolvedModuleData) => !mod.isBarrel && !mod.isTypeOnlyModule;
const getExportedFn = (m: ResolvedModuleData) => m.exportedFunction;

const involvesAnyTarget = (dag: BuiltProjectDag) => (files: ReadonlyArray<string>) => {
  const targetFiles = new Set(
    RA.map(getRelativePath)(RA.filter(isTargetModule)(Array.from(dag.modules.values()))),
  );
  return RA.some(inSet(targetFiles))(files);
};

const toStrategyEntry =
  (mod: ResolvedModuleData) =>
  (sig: string): StrategyEntry => ({
    sig: normalizeTypeText(sig).replace(/\(\s*[a-zA-Z_$][\w$]*\s*:\s*/g, '('),
    mod,
  });

const extractStrategyEntry = (mod: ResolvedModuleData): O.Option<StrategyEntry> =>
  B.match(
    () => O.none,
    () => O.map(toStrategyEntry(mod))(mod.exportedSignature),
  )(isActiveModule(mod) && mod.referencedDomainTypes.length > 0);

const getStrategySig = (e: StrategyEntry) => e.sig;
const getStrategyMod = (e: StrategyEntry) => e.mod;

const buildStrategyHint = (input: {
  readonly sig: string;
  readonly mods: ReadonlyArray<ResolvedModuleData>;
  readonly files: ReadonlyArray<string>;
  readonly idx: number;
}) => {
  const symbols = sortStrings(RA.filterMap(getExportedFn)(input.mods));
  return {
    hintId: `architectural-motif-strategy-${input.idx + 1}`,
    category: 'architectural-motif' as const,
    priority: 'medium' as const,
    files: input.files,
    symbols,
    evidence: `${input.mods.length} parallel modules (${symbols.join(', ')}) implement the identical domain contract \`${input.sig}\`.`,
    suggestion:
      'Recognize this emergent Strategy / Handler Registry pattern: define a shared named Strategy type alias and dispatch via a typed Record<StrategyKey, Handler> or exhaustive ts-pattern matcher.',
    suggestedSignature: O.some(`export type StrategyHandler = ${input.sig};`),
    researchQuestions: [
      `Are ${symbols.join(', ')} interchangeable strategies selected by a domain discriminant tag?`,
    ],
  };
};

const toStrategyHint =
  (input: { readonly dag: BuiltProjectDag; readonly minOcc: number }) =>
  (
    pair: readonly [readonly [string, RNEA.ReadonlyNonEmptyArray<StrategyEntry>], number],
  ): O.Option<CrossFileHint> => {
    const [[sig, entries], idx] = pair;
    const mods = RA.map(getStrategyMod)(entries);
    const files = sortStrings(RA.map(getRelativePath)(mods));
    return B.match(
      () => O.none,
      () => O.some(buildStrategyHint({ sig, mods, files, idx })),
    )(mods.length >= input.minOcc && involvesAnyTarget(input.dag)(files));
  };

const detectParallelStrategyMotif = (input: ArchitecturalMotifInput) => {
  const entries = RA.filterMap(extractStrategyEntry)(Array.from(input.dag.modules.values()));
  const grouped = RNEA.groupBy(getStrategySig)(entries);
  const groupEntries = Object.entries(grouped);
  return RA.filterMap(toStrategyHint({ dag: input.dag, minOcc: input.minOcc }))(
    RA.zip(RA.makeBy(groupEntries.length, identityNum))(groupEntries),
  );
};

const getEdgeSet =
  (edgeMap: ReadonlyMap<string, ReadonlySet<string>>) =>
  (filePath: string) =>
    Array.from(
      O.getOrElse(constant<ReadonlySet<string>>(new Set()))(
        O.fromNullable(edgeMap.get(filePath)),
      ),
    );

const toLeakyEdgeFromTarget =
  (caller: ResolvedModuleData) =>
  (targetMod: ResolvedModuleData): O.Option<LeakyEdge> =>
    B.match(
      () => O.none,
      () => O.some({ caller, callee: targetMod }),
    )(!targetMod.isBarrel && isEffectfulIo(targetMod.exportedEffects));

const toLeakyEdgeIfIo =
  (input: { readonly dag: BuiltProjectDag; readonly caller: ResolvedModuleData }) =>
  (targetFile: string): O.Option<LeakyEdge> =>
    O.chain(toLeakyEdgeFromTarget(input.caller))(
      O.fromNullable(input.dag.modules.get(targetFile)),
    );

const collectModLeakyEdges =
  (dag: BuiltProjectDag) =>
  (mod: ResolvedModuleData): ReadonlyArray<LeakyEdge> => {
    const eligible =
      isActiveModule(mod) &&
      mod.exportedEffects.length > 0 &&
      !isEffectfulIo(mod.exportedEffects);
    return B.match(
      () => [],
      () =>
        RA.filterMap(toLeakyEdgeIfIo({ dag, caller: mod }))(
          getEdgeSet(dag.runtimeOutEdges)(mod.filePath),
        ),
    )(eligible);
  };

const buildLeakyEdgeHint = (pair: readonly [LeakyEdge, number]) => {
  const [{ caller, callee }, idx] = pair;
  const callerFn = O.getOrElse(constant(caller.relativePath))(caller.exportedFunction);
  const calleeFn = O.getOrElse(constant(callee.relativePath))(callee.exportedFunction);
  return {
    hintId: `architectural-motif-effect-leak-${idx + 1}`,
    category: 'architectural-motif' as const,
    priority: 'high' as const,
    files: [caller.relativePath, callee.relativePath],
    symbols: [callerFn, calleeFn],
    evidence: `Pure/synchronous module "${caller.relativePath}" (${caller.exportedEffects.join('/')}) imports async/I/O module "${callee.relativePath}" (${callee.exportedEffects.join('/')}).`,
    suggestion:
      'Apply Functional Core, Imperative Shell: keep pure domain modules free of async/I/O dependencies and pass fetched data into pure functions from the outer TaskEither shell.',
    suggestedSignature: O.none,
    researchQuestions: [
      `Can "${calleeFn}" be invoked in an outer TaskEither shell so "${callerFn}" stays purely synchronous?`,
    ],
  };
};

const toLeakyEdgeHint = (pair: readonly [LeakyEdge, number]): O.Option<CrossFileHint> => {
  const [{ caller, callee }] = pair;
  return B.match(
    () => O.none,
    () => O.some(buildLeakyEdgeHint(pair)),
  )(caller.isTarget || callee.isTarget);
};

const getSetSize = (s: ReadonlySet<string>) => s.size;

const isIoLeafNode =
  (input: { readonly dag: BuiltProjectDag; readonly mod: ResolvedModuleData }) =>
  (node: ProjectModuleNode) => {
    const inDeg = O.getOrElse(constant(0))(
      O.map(getSetSize)(O.fromNullable(input.dag.runtimeInEdges.get(input.mod.filePath))),
    );
    return (
      isActiveModule(input.mod) &&
      node.layer === 0 &&
      isEffectfulIo(input.mod.exportedEffects) &&
      inDeg > 0
    );
  };

const isIoLeaf =
  (dag: BuiltProjectDag) =>
  (m: ResolvedModuleData) =>
    O.exists(isIoLeafNode({ dag, mod: m }))(O.fromNullable(dag.nodeByFile.get(m.filePath)));

const isModUnvisitedIoCaller =
  (input: { readonly visited: ReadonlySet<string>; readonly caller: string }) =>
  (callerMod: ResolvedModuleData) =>
    !callerMod.isBarrel &&
    isEffectfulIo(callerMod.exportedEffects) &&
    !input.visited.has(input.caller);

const isEligibleUnvisitedIoCaller =
  (input: { readonly dag: BuiltProjectDag; readonly visited: ReadonlySet<string> }) =>
  (caller: string) =>
    O.exists(isModUnvisitedIoCaller({ visited: input.visited, caller }))(
      O.fromNullable(input.dag.modules.get(caller)),
    );

const expandIoBfsNode =
  (input: { readonly dag: BuiltProjectDag; readonly state: IoBfsState }) =>
  (curr: string): readonly [string, IoBfsState] => {
    const eligibleCallers = RA.filter(
      isEligibleUnvisitedIoCaller({ dag: input.dag, visited: input.state.visited }),
    )(getEdgeSet(input.dag.runtimeInEdges)(curr));
    const nextVisited = new Set([...input.state.visited, ...eligibleCallers]);
    const nextQueue = [...input.state.queue.slice(1), ...eligibleCallers];
    return [curr, { queue: nextQueue, visited: nextVisited }] as const;
  };

const stepIoBfs =
  (dag: BuiltProjectDag) =>
  (state: IoBfsState): O.Option<readonly [string, IoBfsState]> =>
    O.map(expandIoBfsNode({ dag, state }))(RA.head(state.queue));

const getNodeLayer = (n: ProjectModuleNode) => n.layer;

const lookupLayer = (dag: BuiltProjectDag) => (f: string) =>
  O.getOrElse(constant(0))(O.map(getNodeLayer)(O.fromNullable(dag.nodeByFile.get(f))));

const lookupRelativePath = (dag: BuiltProjectDag) => (f: string) =>
  O.map(getRelativePath)(O.fromNullable(dag.modules.get(f)));

const lookupExportedFn = (dag: BuiltProjectDag) => (f: string) =>
  O.chain(getExportedFn)(O.fromNullable(dag.modules.get(f)));

const buildDeepIoHint = (input: {
  readonly files: ReadonlyArray<string>;
  readonly symbols: ReadonlyArray<string>;
  readonly layerCount: number;
}) => ({
  hintId: 'architectural-motif-deep-io-chain',
  category: 'architectural-motif' as const,
  priority: 'medium' as const,
  files: input.files,
  symbols: input.symbols,
  evidence: `Async/I/O effects propagate across ${input.layerCount} DAG layers and ${input.files.length} modules (${input.files.join(', ')}) starting from leaf I/O modules.`,
  suggestion:
    'Apply Functional Core, Imperative Shell (Ports & Adapters): fetch inputs at the boundary shell, compose intermediate domain logic as pure Either functions, and persist results at the edge.',
  suggestedSignature: O.none,
  researchQuestions: [
    'Which intermediate modules in this TaskEither chain are pure business logic that only became async because they call a leaf I/O module directly?',
  ],
});

const runDeepIoBfs = (input: {
  readonly dag: BuiltProjectDag;
  readonly minOcc: number;
  readonly ioLeafPaths: ReadonlyArray<string>;
}) => {
  const initial: IoBfsState = {
    queue: input.ioLeafPaths,
    visited: new Set(input.ioLeafPaths),
  };
  const ioPropagated = RA.unfold(initial, stepIoBfs(input.dag));
  const propagatedLayers = new Set(RA.map(lookupLayer(input.dag))(ioPropagated));
  const files = sortStrings(RA.filterMap(lookupRelativePath(input.dag))(ioPropagated));
  const symbols = sortStrings(RA.filterMap(lookupExportedFn(input.dag))(ioPropagated));
  return B.match(
    () => [],
    () => [buildDeepIoHint({ files, symbols, layerCount: propagatedLayers.size })],
  )(
    ioPropagated.length >= input.minOcc &&
      propagatedLayers.size >= 3 &&
      involvesAnyTarget(input.dag)(files),
  );
};

const detectDeepIoChain = (input: ArchitecturalMotifInput) => {
  const ioLeafPaths = RA.map(getFilePath)(
    RA.filter(isIoLeaf(input.dag))(Array.from(input.dag.modules.values())),
  );
  return B.match(
    () => [],
    () => runDeepIoBfs({ dag: input.dag, minOcc: input.minOcc, ioLeafPaths }),
  )(ioLeafPaths.length > 0);
};

const detectEffectLayerLeakage = (input: ArchitecturalMotifInput) => {
  const leakyEdges = RA.chain(collectModLeakyEdges(input.dag))(
    Array.from(input.dag.modules.values()),
  );
  const directHints = RA.filterMap(toLeakyEdgeHint)(
    RA.zip(RA.makeBy(leakyEdges.length, identityNum))(leakyEdges),
  );
  return [...directHints, ...detectDeepIoChain(input)];
};

const prependChildren =
  (input: { readonly sf: ts.SourceFile; readonly rest: ReadonlyArray<ts.Node> }) =>
  (head: ts.Node): readonly [ts.Node, ReadonlyArray<ts.Node>] => [
    head,
    [...head.getChildren(input.sf), ...input.rest],
  ];

const stepNode = (sf: ts.SourceFile) => (stack: ReadonlyArray<ts.Node>) =>
  O.map(prependChildren({ sf, rest: stack.slice(1) }))(RA.head(stack));

const collectAllNodes = (sf: ts.SourceFile) => {
  const initial: ReadonlyArray<ts.Node> = [sf];
  return RA.unfold(initial, stepNode(sf));
};

const isOutermostPropAccess = (node: ts.Node): node is ts.PropertyAccessExpression =>
  ts.isPropertyAccessExpression(node) && !ts.isPropertyAccessExpression(node.parent);

const toPropChainTuple = (pa: ts.PropertyAccessExpression) =>
  [{ name: pa.name.text, base: pa.expression }, pa.expression] as const;

const stepPropChain = (curr: ts.Expression) =>
  O.map(toPropChainTuple)(O.fromPredicate(ts.isPropertyAccessExpression)(curr));

const getSymbolName = (sym: ts.Symbol) => sym.getName();

const getTypeSymName = (t: ts.Type) =>
  O.getOrElse(constant(''))(
    O.map(getSymbolName)(
      RA.head(RA.compact([O.fromNullable(t.aliasSymbol), O.fromNullable(t.getSymbol())])),
    ),
  );

const isImportedNamespaceOrDefault =
  (identName: string) =>
  (imp: ImportInfo) =>
    O.exists((v: string) => v === identName)(imp.namespaceImport) ||
    O.exists((v: string) => v === identName)(imp.defaultImport);

const getStepName = (s: PropChainStep) => s.name;

const validateAndBuildOptic =
  (input: {
    readonly mod: ResolvedModuleData;
    readonly checker: ts.TypeChecker;
    readonly parts: ReadonlyArray<string>;
  }) =>
  (id: ts.Identifier): O.Option<OpticOccurrence> => {
    const rootType = input.checker.getTypeAtLocation(id);
    const rootTypeName = getTypeSymName(rootType);
    const isValidRoot =
      rootTypeName.length > 0 &&
      !rootTypeName.startsWith('__') &&
      !isPrimitiveOrStdType(rootTypeName) &&
      !RA.some(isImportedNamespaceOrDefault(id.text))(input.mod.ir.imports);
    return B.match(
      () => O.none,
      () =>
        O.some({
          key: `${rootTypeName}.${input.parts.join('.')}`,
          rootType: rootTypeName,
          pathParts: input.parts,
          file: input.mod.relativePath,
        }),
    )(isValidRoot);
  };

const extractFromLastStep =
  (input: {
    readonly mod: ResolvedModuleData;
    readonly checker: ts.TypeChecker;
    readonly parts: ReadonlyArray<string>;
  }) =>
  (lastStep: PropChainStep): O.Option<OpticOccurrence> =>
    B.match(
      () => O.none,
      () =>
        O.chain(validateAndBuildOptic(input))(
          O.fromPredicate(ts.isIdentifier)(lastStep.base),
        ),
    )(input.parts.length >= 2);

const extractOpticOccurrence =
  (input: { readonly mod: ResolvedModuleData; readonly checker: ts.TypeChecker }) =>
  (node: ts.PropertyAccessExpression): O.Option<OpticOccurrence> => {
    const chainSteps = RA.unfold<PropChainStep, ts.Expression>(node, stepPropChain);
    const rawParts = reverseStrings(RA.map(getStepName)(chainSteps));
    const isTailCall =
      ts.isCallExpression(node.parent) && node.parent.expression === node;
    const parts = B.match(
      () => rawParts,
      () => rawParts.slice(0, -1),
    )(isTailCall);

    return O.chain(
      extractFromLastStep({
        mod: input.mod,
        checker: input.checker,
        parts,
      }),
    )(RA.last(chainSteps));
  };

const collectModuleOptics =
  (checker: ts.TypeChecker) =>
  (mod: ResolvedModuleData) =>
    RA.filterMap(extractOpticOccurrence({ mod, checker }))(
      RA.filter(isOutermostPropAccess)(collectAllNodes(mod.sourceFile)),
    );

const getOpticKey = (o: OpticOccurrence) => o.key;
const getOpticFile = (o: OpticOccurrence) => o.file;
const quoteSingle = (p: string) => `'${p}'`;

const buildOpticHint = (input: {
  readonly first: OpticOccurrence;
  readonly files: ReadonlyArray<string>;
  readonly idx: number;
}) => {
  const pathTuple = RA.map(quoteSingle)(input.first.pathParts).join(', ');
  return {
    hintId: `architectural-motif-shared-optic-${input.idx + 1}`,
    category: 'architectural-motif' as const,
    priority: 'medium' as const,
    files: input.files,
    symbols: [input.first.rootType],
    evidence: `Nested property path "${input.first.rootType}.${input.first.pathParts.join('.')}" is traversed independently across ${input.files.length} modules (${input.files.join(', ')}).`,
    suggestion: `Extract a shared monocle-ts Lens/Optional alongside "${input.first.rootType}" so structural navigation and updates stay decoupled from internal nesting.`,
    suggestedSignature: O.some(
      `Lens.fromPath<${input.first.rootType}>()([${pathTuple}])`,
    ),
    researchQuestions: [
      `Should "${input.first.rootType}" expose a shared Lens/Optional module for [${pathTuple}]?`,
    ],
  };
};

const toOpticHint =
  (input: { readonly dag: BuiltProjectDag; readonly minOcc: number }) =>
  (
    pair: readonly [readonly [string, RNEA.ReadonlyNonEmptyArray<OpticOccurrence>], number],
  ): O.Option<CrossFileHint> => {
    const [[, occs], idx] = pair;
    const files = RA.uniq(S.Eq)(sortStrings(RA.map(getOpticFile)(occs)));
    return B.match(
      () => O.none,
      () => O.some(buildOpticHint({ first: occs[0], files, idx })),
    )(files.length >= input.minOcc && involvesAnyTarget(input.dag)(files));
  };

const detectCrossFileSharedOptics = (input: ArchitecturalMotifInput) => {
  const occurrences = RA.chain(collectModuleOptics(input.checker))(
    RA.filter(isNonBarrel)(Array.from(input.dag.modules.values())),
  );
  const grouped = RNEA.groupBy(getOpticKey)(occurrences);
  const entries = Object.entries(grouped);
  return RA.filterMap(toOpticHint({ dag: input.dag, minOcc: input.minOcc }))(
    RA.zip(RA.makeBy(entries.length, identityNum))(entries),
  );
};

export const discoverArchitecturalMotifs = (({
  dag,
  checker,
  minOcc,
}: ArchitecturalMotifInput): ReadonlyArray<CrossFileHint> => [
  ...detectParallelStrategyMotif({ dag, checker, minOcc }),
  ...detectEffectLayerLeakage({ dag, checker, minOcc }),
  ...detectCrossFileSharedOptics({ dag, checker, minOcc }),
]) satisfies (input: ArchitecturalMotifInput) => ReadonlyArray<CrossFileHint>;
