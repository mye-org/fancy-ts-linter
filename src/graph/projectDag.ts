import * as B from 'fp-ts/lib/boolean.js';
import * as E from 'fp-ts/lib/Either.js';
import * as M from 'fp-ts/lib/Monoid.js';
import * as NEA from 'fp-ts/lib/NonEmptyArray.js';
import * as N from 'fp-ts/lib/number.js';
import * as O from 'fp-ts/lib/Option.js';

import { fromNullable as liftNullable } from 'fp-ts/lib/Option.js';
import * as Ord from 'fp-ts/lib/Ord.js';
import * as RA from 'fp-ts/lib/ReadonlyArray.js';
import * as RR from 'fp-ts/lib/ReadonlyRecord.js';
import * as S from 'fp-ts/lib/string.js';
import * as path from 'node:path';
import * as ts from 'typescript';
import { extractModuleIR } from '../ir/moduleGraph.js';
import type {
  BuiltProjectDag,
  ClusterCount,
  CohesionScore,
  CycleCount,
  DependencyCount,
  DepthCount,
  DirectoryCluster,
  DirectoryCohesionMetric,
  DirectoryCount,
  DirectoryPath,
  EdgeCount,
  JaccardScore,
  LayerIndex,
  ModuleCount,
  ModuleKind,
  ModuleRole,
  ModuleScope,
  ProjectDagSummary,
  ProjectEdge,
  ProjectModuleNode,
  RelativePath,
  ResolvedModuleData,
} from '../model/projectReport.js';
import type { BindingInfo, ModuleIR, SymbolName, TypeInspector, TypeSignature } from '../model/report.js';
const isoSymbolName = iso<SymbolName>();
const isoTypeSignature = iso<TypeSignature>();
import { computeCommonRootDir } from './computeCommonRootDir.js';
import { isDefaultTestOrFixtureFile } from './isDefaultTestOrFixtureFile.js';
import { isTsSourceFile } from './isTsSourceFile.js';
import { matchesExcludePatterns } from './matchesExcludePatterns.js';
import { toRelativeDirectory } from './toRelativeDirectory.js';
import { iso } from 'newtype-ts';
import {
  toRelativePosixPath,
  type FilePath,
  type RootDir,
} from './toRelativePosixPath.js';

export type BuildProjectDagInput = {
  readonly program: ts.Program;
  readonly checker: ts.TypeChecker;
  readonly inspector: TypeInspector;
  readonly targetFiles: ReadonlyArray<string>;
  readonly projectBaseDir: string;
  readonly excludePatterns: ReadonlyArray<string>;
  readonly minDirModules: number;
  readonly preExtractedIRs: ReadonlyMap<string, ModuleIR>;
};

export type BuildProjectDag = (input: BuildProjectDagInput) => BuiltProjectDag;

const makeUncons =
  <A>(arr: ReadonlyArray<A>) =>
  (head: A) => ({ head, tail: arr.slice(1) });

const uncons = <A>(arr: ReadonlyArray<A>) => O.map(makeUncons(arr))(RA.head(arr));

const lookupReverseAt =
  <A>(arr: ReadonlyArray<A>) =>
  (idx: number) =>
    RA.lookup(arr.length - 1 - idx)(arr);

const reverseArray = <A>(arr: ReadonlyArray<A>): ReadonlyArray<A> =>
  B.match(
    () => [] satisfies ReadonlyArray<A>,
    () => RA.filterMap(lookupReverseAt(arr))(RA.range(0, arr.length - 1)),
  )(arr.length > 0);

const negateNumber = (n: number) => -n;

const descNumberOrd = Ord.contramap(negateNumber)(N.Ord);

const isFpCorePackage = (pkg: string) =>
  pkg === 'fp-ts' || pkg === 'monocle-ts' || pkg === 'newtype-ts' || pkg === 'ts-pattern';

const isNotFpCorePackage = (pkg: string) => !isFpCorePackage(pkg);

const isBuiltinOrContainerTypeName = (name: string) =>
  new Set([
    'Array',
    'ReadonlyArray',
    'Record',
    'Readonly',
    'Partial',
    'Required',
    'Pick',
    'Omit',
    'Exclude',
    'Extract',
    'NonNullable',
    'ReturnType',
    'Parameters',
    'Promise',
    'PromiseLike',
    'Map',
    'ReadonlyMap',
    'Set',
    'ReadonlySet',
    'Date',
    'RegExp',
    'Error',
    'Function',
    'Object',
    'Option',
    'Some',
    'None',
    'Either',
    'Left',
    'Right',
    'Task',
    'TaskEither',
    'Reader',
    'ReaderTask',
    'ReaderTaskEither',
    'IO',
    'IOEither',
    'State',
    'Newtype',
    'Iso',
    'Lens',
    'Prism',
    'Optional',
    'Traversal',
    'Eq',
    'Ord',
    'Semigroup',
    'Monoid',
    'Show',
    '__type',
    '__object',
  ]).has(name);

const extractScopedPackageName = (specifier: string) => {
  const parts = specifier.split('/');
  return B.match(
    () => specifier,
    () => `${parts[0]}/${parts[1]}`,
  )(parts.length >= 2);
};

const extractUnscopedPackageName = (specifier: string) => {
  const slashIdx = specifier.indexOf('/');
  return B.match(
    () => specifier.slice(0, slashIdx),
    () => specifier,
  )(slashIdx === -1);
};

const extractPackageName = (specifier: string) =>
  B.match(
    () =>
      B.match(
        () => extractUnscopedPackageName(specifier),
        () => extractScopedPackageName(specifier),
      )(specifier.startsWith('@')),
    () => specifier,
  )(specifier.startsWith('node:'));

const isRelativeOrAbsoluteSpecifier = (specifier: string) =>
  specifier.startsWith('.') || specifier.startsWith('/');

const isTypeReference = (t: ts.Type): t is ts.TypeReference =>
  'target' in t && 'typeArguments' in t;

const isUnionOrIntersectionType = (t: ts.Type): t is ts.UnionOrIntersectionType =>
  t.isUnionOrIntersection();

const getFirstDeclaration = (sym: ts.Symbol) =>
  O.chain(RA.head)(liftNullable(sym.declarations));

const getSourceFileName = (decl: ts.Declaration) => decl.getSourceFile().fileName;

const getDeclFileName = (sym: ts.Symbol) =>
  O.getOrElse(() => '')(O.map(getSourceFileName)(getFirstDeclaration(sym)));

const getSymbolDomainName = (sym: ts.Symbol) => {
  const name = sym.getName();
  const isValid =
    name.length > 0 &&
    !isBuiltinOrContainerTypeName(name) &&
    !name.startsWith('__') &&
    !getDeclFileName(sym).includes('node_modules/typescript/lib/');
  return B.match(
    () => [] satisfies ReadonlyArray<string>,
    () => [name],
  )(isValid);
};

type CollectContext = {
  readonly checker: ts.TypeChecker;
  readonly visited: ReadonlySet<ts.Type>;
  readonly depth: number;
};

type CollectDomainTypesInput = {
  readonly checker: ts.TypeChecker;
  readonly type: ts.Type;
  readonly visited: ReadonlySet<ts.Type>;
  readonly depth: number;
};

const collectForType =
  ({ checker, visited, depth }: CollectContext) =>
  (t: ts.Type): ReadonlyArray<string> =>
    collectDomainTypeNamesFromType({ checker, type: t, visited, depth });

const collectParamTypeNames =
  ({ checker, visited, depth }: CollectContext) =>
  (param: ts.Symbol) =>
    collectDomainTypeNamesFromType({
      checker,
      type: checker.getTypeOfSymbol(param),
      visited,
      depth,
    });

const collectSigTypeNames =
  ({ checker, visited, depth }: CollectContext) =>
  (sig: ts.Signature): ReadonlyArray<string> => [
    ...RA.chain(collectParamTypeNames({ checker, visited, depth: depth + 1 }))(
      sig.getParameters(),
    ),
    ...collectDomainTypeNamesFromType({
      checker,
      type: sig.getReturnType(),
      visited,
      depth: depth + 1,
    }),
  ];

const collectDirectSymbolNames = (type: ts.Type) =>
  B.match(
    () => [] satisfies ReadonlyArray<string>,
    () =>
      O.match(
        () => [] satisfies ReadonlyArray<string>,
        getSymbolDomainName,
      )(O.match(() => liftNullable(type.getSymbol()), O.some<ts.Symbol>)(liftNullable(type.aliasSymbol))),
  )(type.getCallSignatures().length === 0);

const collectUnionTypeMembers = (ctx: CollectContext) => (unionType: ts.UnionOrIntersectionType) =>
  RA.chain(collectForType(ctx))(unionType.types);

const collectUnionNames = (ctx: CollectContext) => (type: ts.Type) =>
  O.match(
    () => [] satisfies ReadonlyArray<string>,
    collectUnionTypeMembers(ctx),
  )(O.fromPredicate(isUnionOrIntersectionType)(type));

const collectTypeRefArgs = (ctx: CollectContext) => (typeRef: ts.TypeReference) =>
  RA.chain(collectForType(ctx))(ctx.checker.getTypeArguments(typeRef));

const collectTypeArgNames = (ctx: CollectContext) => (type: ts.Type) =>
  O.match(
    () => [] satisfies ReadonlyArray<string>,
    collectTypeRefArgs(ctx),
  )(O.fromPredicate(isTypeReference)(type));

const collectDomainTypesActive = ({
  checker,
  type,
  visited,
  depth,
}: CollectDomainTypesInput) => {
  const nextVisited = new Set([...visited, type]);
  const childCtx = { checker, visited: nextVisited, depth: depth + 1 };
  const sigCtx = { checker, visited: nextVisited, depth };
  const sigNames = B.match(
    () => [] satisfies ReadonlyArray<string>,
    () => RA.chain(collectSigTypeNames(sigCtx))(type.getCallSignatures()),
  )(depth <= 2);
  return [
    ...collectDirectSymbolNames(type),
    ...collectUnionNames(childCtx)(type),
    ...collectTypeArgNames(childCtx)(type),
    ...sigNames,
  ];
};

const collectDomainTypeNamesFromType = ({
  checker,
  type,
  visited,
  depth,
}: CollectDomainTypesInput): ReadonlyArray<string> =>
  B.match(
    () => collectDomainTypesActive({ checker, type, visited, depth }),
    () => [] satisfies ReadonlyArray<string>,
  )(depth > 3 || visited.has(type));

const isNotPureEffect = (effect: string) => effect !== 'Pure';

type DetectDeepEffectsContext = {
  readonly inspector: TypeInspector;
  readonly depth: number;
};

type DetectDeepEffectsInput = {
  readonly inspector: TypeInspector;
  readonly type: ts.Type;
  readonly depth: number;
};

const collectReturnEffects =
  ({ inspector, depth }: DetectDeepEffectsContext) =>
  (sig: ts.Signature): ReadonlyArray<string> => {
    const ret = sig.getReturnType();
    return B.match(
      () => [] satisfies ReadonlyArray<string>,
      () =>
        RA.filter(isNotPureEffect)(
          detectDeepEffects({ inspector, type: ret, depth: depth + 1 }),
        ),
    )(ret.getCallSignatures().length > 0);
  };

const detectNestedEffects = ({ inspector, type, depth }: DetectDeepEffectsInput) => {
  const nested = RA.uniq(S.Eq)(
    RA.chain(collectReturnEffects({ inspector, depth }))(type.getCallSignatures()),
  );
  return B.match(
    () => ['Pure'] satisfies ReadonlyArray<string>,
    () => nested,
  )(nested.length > 0);
};

const detectDeepEffectsActive = ({ inspector, type, depth }: DetectDeepEffectsInput) => {
  const direct = RA.filter(isNotPureEffect)(inspector.detectEffects(type));
  return B.match(
    () => detectNestedEffects({ inspector, type, depth }),
    () => direct,
  )(direct.length > 0);
};

const detectDeepEffects = ({
  inspector,
  type,
  depth,
}: DetectDeepEffectsInput): ReadonlyArray<string> =>
  B.match(
    () => detectDeepEffectsActive({ inspector, type, depth }),
    () => ['Pure'] satisfies ReadonlyArray<string>,
  )(depth > 4);

type PrimitiveKind = 'string' | 'number' | 'boolean';

const classifyPrimitiveType = (paramType: ts.Type): O.Option<PrimitiveKind> =>
  B.match(
    () =>
      B.match(
        () =>
          B.match(
            () => O.none satisfies O.Option<PrimitiveKind>,
            () => O.some<PrimitiveKind>('boolean'),
          )((paramType.flags & ts.TypeFlags.BooleanLike) !== 0),
        () => O.some<PrimitiveKind>('number'),
      )((paramType.flags & ts.TypeFlags.NumberLike) !== 0),
    () => O.some<PrimitiveKind>('string'),
  )((paramType.flags & ts.TypeFlags.StringLike) !== 0);

const classifyParamList =
  ({ checker, params }: { readonly checker: ts.TypeChecker; readonly params: ReadonlyArray<ts.Symbol> }) =>
  (param: ts.Symbol) =>
    B.match(
      () => O.none satisfies O.Option<PrimitiveKind>,
      () => classifyPrimitiveType(checker.getTypeOfSymbol(param)),
    )(params.length === 1);

const classifySingleParam =
  (checker: ts.TypeChecker) => (params: ReadonlyArray<ts.Symbol>) =>
    O.chain(classifyParamList({ checker, params }))(RA.head(params));

const classifySingleSig = (checker: ts.TypeChecker) => (sig: ts.Signature) =>
  classifySingleParam(checker)(sig.getParameters());

const extractPrimitiveInputKind = (checker: ts.TypeChecker) => (type: ts.Type) => {
  const sigs = type.getCallSignatures();
  return O.chain(classifySingleSig(checker))(
    B.match(
      () => O.none,
      () => RA.head(sigs),
    )(sigs.length === 1),
  );
};

const isPrimaryBinding = (binding: BindingInfo) => binding.visibility === 'exported' && binding.kind !== 'other';

const findPrimaryExportedBinding = (ir: ModuleIR) => RA.findFirst(isPrimaryBinding)(ir.bindings);

const isReExportDecl = (stmt: ts.Statement): stmt is ts.ExportDeclaration =>
  ts.isExportDeclaration(stmt) && stmt.moduleSpecifier !== undefined;

const isRuntimeReExport = (stmt: ts.ExportDeclaration) => !stmt.isTypeOnly;

const detectBarrelAndTypeOnly = (sf: ts.SourceFile) => (ir: ModuleIR) => {
  const reExports = RA.filter(isReExportDecl)(sf.statements);
  const hasAnyReExport = reExports.length > 0;
  const hasRuntimeReExport = RA.some(isRuntimeReExport)(reExports);
  const hasLocalRuntimeBindings = ir.bindings.length > 0;
  return {
    isBarrel: !hasLocalRuntimeBindings && hasAnyReExport,
    isTypeOnlyModule: !hasLocalRuntimeBindings && !hasRuntimeReExport,
  };
};

type RawModuleRef = {
  readonly specifier: string;
  readonly isTypeOnly: boolean;
  readonly symbols: ReadonlyArray<string>;
};

const getExportNameText = (n: ts.ModuleExportName) => n.text;

const getNamedImportSymbol = (el: ts.ImportSpecifier) =>
  O.getOrElse(() => getExportNameText(el.name))(
    O.map(getExportNameText)(liftNullable(el.propertyName)),
  );

const getNamedExportSymbol = (el: ts.ExportSpecifier) =>
  O.getOrElse(() => getExportNameText(el.name))(
    O.map(getExportNameText)(liftNullable(el.propertyName)),
  );

const extractNamespaceSymbols = (ns: ts.NamespaceImport) => [
  `* as ${getExportNameText(ns.name)}`,
] satisfies ReadonlyArray<string>;

const extractNamedImportsList = (named: ts.NamedImports) =>
  RA.map(getNamedImportSymbol)(named.elements);

const extractNamedImportBindings = (bindings: ts.NamedImportBindings) =>
  O.match(
    () =>
      O.match(
        () => [] satisfies ReadonlyArray<string>,
        extractNamedImportsList,
      )(O.fromPredicate(ts.isNamedImports)(bindings)),
    extractNamespaceSymbols,
  )(O.fromPredicate(ts.isNamespaceImport)(bindings));

const extractDefaultImportSymbol = (name: ts.Identifier) => [
  name.text,
] satisfies ReadonlyArray<string>;

const extractImportClauseSymbols = (clause: ts.ImportClause) => [
  ...O.match(() => [] satisfies ReadonlyArray<string>, extractDefaultImportSymbol)(
    liftNullable(clause.name),
  ),
  ...O.match(() => [] satisfies ReadonlyArray<string>, extractNamedImportBindings)(
    liftNullable(clause.namedBindings),
  ),
];

const isClauseTypeOnly = (clause: ts.ImportClause) => clause.isTypeOnly === true;

const buildImportDeclRef = (decl: ts.ImportDeclaration) => (modSpec: ts.StringLiteral): RawModuleRef => ({
  specifier: modSpec.text,
  isTypeOnly: O.getOrElse(() => false)(O.map(isClauseTypeOnly)(liftNullable(decl.importClause))),
  symbols: O.match(() => [] satisfies ReadonlyArray<string>, extractImportClauseSymbols)(
    liftNullable(decl.importClause),
  ),
});

const extractImportDeclRef = (decl: ts.ImportDeclaration) =>
  O.map(buildImportDeclRef(decl))(O.fromPredicate(ts.isStringLiteral)(decl.moduleSpecifier));

const extractNamedExportsList = (named: ts.NamedExports) =>
  RA.map(getNamedExportSymbol)(named.elements);

const extractExportClauseSymbols = (clause: ts.NamedExportBindings) =>
  O.match(() => ['*'] satisfies ReadonlyArray<string>, extractNamedExportsList)(
    O.fromPredicate(ts.isNamedExports)(clause),
  );

const buildExportDeclRef = (decl: ts.ExportDeclaration) => (modSpec: ts.StringLiteral): RawModuleRef => ({
  specifier: modSpec.text,
  isTypeOnly: decl.isTypeOnly,
  symbols: O.match(() => ['*'] satisfies ReadonlyArray<string>, extractExportClauseSymbols)(
    liftNullable(decl.exportClause),
  ),
});

const extractExportDeclFromExpr = (decl: ts.ExportDeclaration) => (modExpr: ts.Expression) =>
  O.map(buildExportDeclRef(decl))(O.fromPredicate(ts.isStringLiteral)(modExpr));

const extractExportDeclRef = (decl: ts.ExportDeclaration) =>
  O.chain(extractExportDeclFromExpr(decl))(liftNullable(decl.moduleSpecifier));

const extractStatementRef = (stmt: ts.Statement) =>
  O.match(
    () => O.chain(extractExportDeclRef)(O.fromPredicate(ts.isExportDeclaration)(stmt)),
    O.some<RawModuleRef>,
  )(O.chain(extractImportDeclRef)(O.fromPredicate(ts.isImportDeclaration)(stmt)));

type InternalRefItem = {
  readonly targetFile: string;
  readonly isTypeOnly: boolean;
  readonly importedSymbols: ReadonlyArray<string>;
};

type ResolveRefContext = {
  readonly sfFileName: string;
  readonly compilerOptions: ts.CompilerOptions;
  readonly inScopeFiles: ReadonlySet<string>;
  readonly resolutionCache: ts.ModuleResolutionCache;
};

const getResolvedFileName = (mod: ts.ResolvedModuleFull) => path.resolve(mod.resolvedFileName);

const checkIsInternalFile =
  ({ inScopeFiles, sfFileName }: { readonly inScopeFiles: ReadonlySet<string>; readonly sfFileName: string }) =>
  (resolvedFile: string) =>
    inScopeFiles.has(resolvedFile) && resolvedFile !== path.resolve(sfFileName);

const makeInternalRefEither =
  (rawRef: RawModuleRef) =>
  (targetFile: string): E.Either<InternalRefItem, string> =>
    E.left({
      targetFile,
      isTypeOnly: rawRef.isTypeOnly,
      importedSymbols: rawRef.symbols,
    });

const resolveRawRef =
  ({ sfFileName, compilerOptions, inScopeFiles, resolutionCache }: ResolveRefContext) =>
  (rawRef: RawModuleRef): O.Option<E.Either<InternalRefItem, string>> => {
    const resolved = ts.resolveModuleName(
      rawRef.specifier,
      sfFileName,
      compilerOptions,
      ts.sys,
      resolutionCache,
    );
    const resolvedFileOpt = O.map(getResolvedFileName)(liftNullable(resolved.resolvedModule));
    const isInternal = O.getOrElse(() => false)(
      O.map(checkIsInternalFile({ inScopeFiles, sfFileName }))(resolvedFileOpt),
    );
    return B.match(
      () =>
        B.match(
          () => O.some(E.right(extractPackageName(rawRef.specifier))),
          () => O.none,
        )(isRelativeOrAbsoluteSpecifier(rawRef.specifier)),
      () => O.map(makeInternalRefEither(rawRef))(resolvedFileOpt),
    )(isInternal);
  };

const getInternalRefTarget = (ref: InternalRefItem) => ref.targetFile;

const isInternalRefTypeOnly = (ref: InternalRefItem) => ref.isTypeOnly;

const getInternalRefSymbols = (ref: InternalRefItem) => ref.importedSymbols;

const getTupleFirstString = ([k]: readonly [string, unknown]) => k;

const internalEntryOrd = Ord.contramap(getTupleFirstString)(S.Ord);

const mergeInternalRefGroup = ([targetFile, refs]: readonly [
  string,
  NEA.NonEmptyArray<InternalRefItem>,
]) => ({
  targetFile,
  isTypeOnly: RA.every(isInternalRefTypeOnly)(refs),
  importedSymbols: RA.sortBy([S.Ord])(RA.uniq(S.Eq)(RA.chain(getInternalRefSymbols)(refs))),
});

const resolveModuleReferences =
  ({
    program,
    inScopeFiles,
    resolutionCache,
  }: {
    readonly program: ts.Program;
    readonly inScopeFiles: ReadonlySet<string>;
    readonly resolutionCache: ts.ModuleResolutionCache;
  }) =>
  (sf: ts.SourceFile) => {
    const rawRefs = RA.filterMap(extractStatementRef)(sf.statements);
    const partitioned = RA.separate(
      RA.filterMap(
        resolveRawRef({
          sfFileName: sf.fileName,
          compilerOptions: program.getCompilerOptions(),
          inScopeFiles,
          resolutionCache,
        }),
      )(rawRefs),
    );
    const groupedInternal = RR.toEntries(NEA.groupBy(getInternalRefTarget)([...partitioned.left]));
    const internalImports = RA.map(mergeInternalRefGroup)(
      RA.sortBy([internalEntryOrd])(groupedInternal),
    );
    const externalDependencies = RA.sortBy([S.Ord])(RA.uniq(S.Eq)(partitioned.right));
    const domainExternalDependencies = RA.filter(isNotFpCorePackage)(externalDependencies);
    return { internalImports, externalDependencies, domainExternalDependencies };
  };

type BfsState = {
  readonly queue: ReadonlyArray<string>;
  readonly visited: ReadonlySet<string>;
};

type BfsInput = {
  readonly initialQueue: ReadonlyArray<string>;
  readonly initialVisited: ReadonlySet<string>;
  readonly edges: ReadonlyMap<string, ReadonlySet<string>>;
};

const isNotVisited = (visited: ReadonlySet<string>) => (node: string) => !visited.has(node);
const isVisited = (visited: ReadonlySet<string>) => (node: string) => visited.has(node);

const getSetOrEmpty = (edges: ReadonlyMap<string, ReadonlySet<string>>) => (key: string) =>
  Array.from(
    O.getOrElse((): ReadonlySet<string> => new Set())(liftNullable(edges.get(key))),
  );

const advanceBfs =
  ({ edges, state }: { readonly edges: ReadonlyMap<string, ReadonlySet<string>>; readonly state: BfsState }) =>
  ({ head, tail }: { readonly head: string; readonly tail: ReadonlyArray<string> }) => {
    const nextNeighbors = RA.filter(isNotVisited(state.visited))(getSetOrEmpty(edges)(head));
    return [
      head,
      {
        queue: [...tail, ...nextNeighbors],
        visited: new Set([...state.visited, ...nextNeighbors]),
      },
    ] as const;
  };

const bfsStep =
  (edges: ReadonlyMap<string, ReadonlySet<string>>) =>
  (state: BfsState): O.Option<readonly [string, BfsState]> =>
    O.map(advanceBfs({ edges, state }))(uncons(state.queue));

const bfsCollect = ({ initialQueue, initialVisited, edges }: BfsInput) =>
  RA.unfold({ queue: initialQueue, visited: initialVisited }, bfsStep(edges));

type DfsState = {
  readonly visited: ReadonlySet<string>;
  readonly order: ReadonlyArray<string>;
};

type DfsStepInput = {
  readonly outEdges: ReadonlyMap<string, ReadonlySet<string>>;
  readonly state: DfsState;
};

const stepVisitNeighbor =
  ({ outEdges, state }: DfsStepInput) =>
  ({ head, tail }: { readonly head: string; readonly tail: ReadonlyArray<string> }): DfsState =>
    visitNeighbors({ outEdges, state: dfsPostOrder({ outEdges, state })(head) })(tail);

const visitNeighbors =
  ({ outEdges, state }: DfsStepInput) =>
  (neighbors: ReadonlyArray<string>): DfsState =>
    O.match(() => state, stepVisitNeighbor({ outEdges, state }))(uncons(neighbors));

const dfsExploreNode = ({
  outEdges,
  state,
  node,
}: {
  readonly outEdges: ReadonlyMap<string, ReadonlySet<string>>;
  readonly state: DfsState;
  readonly node: string;
}) => {
  const nextState = { visited: new Set([...state.visited, node]), order: state.order };
  const afterNeighbors = visitNeighbors({ outEdges, state: nextState })(
    getSetOrEmpty(outEdges)(node),
  );
  return { visited: afterNeighbors.visited, order: [...afterNeighbors.order, node] };
};

const dfsPostOrder =
  ({ outEdges, state }: DfsStepInput) =>
  (node: string): DfsState =>
    B.match(
      () => dfsExploreNode({ outEdges, state, node }),
      () => state,
    )(state.visited.has(node));

type SccCollectState = {
  readonly remaining: ReadonlyArray<string>;
  readonly visited: ReadonlySet<string>;
};

const advanceSccCollect =
  ({ inEdges, state }: { readonly inEdges: ReadonlyMap<string, ReadonlySet<string>>; readonly state: SccCollectState }) =>
  ({ head, tail }: { readonly head: string; readonly tail: ReadonlyArray<string> }) => {
    const component = bfsCollect({
      initialQueue: [head],
      initialVisited: new Set([...state.visited, head]),
      edges: inEdges,
    });
    return [
      component,
      {
        remaining: tail,
        visited: new Set([...state.visited, ...component]),
      },
    ] as const;
  };

const sccCollectStep =
  (inEdges: ReadonlyMap<string, ReadonlySet<string>>) =>
  (state: SccCollectState): O.Option<readonly [ReadonlyArray<string>, SccCollectState]> =>
    O.map(advanceSccCollect({ inEdges, state }))(
      uncons(RA.dropLeftWhile(isVisited(state.visited))(state.remaining)),
    );

const computeSccs = ({
  nodes,
  outEdges,
  inEdges,
}: {
  readonly nodes: ReadonlyArray<string>;
  readonly outEdges: ReadonlyMap<string, ReadonlySet<string>>;
  readonly inEdges: ReadonlyMap<string, ReadonlySet<string>>;
}) => {
  const { order } = visitNeighbors({ outEdges, state: { visited: new Set(), order: [] } })(nodes);
  return RA.unfold(
    { remaining: reverseArray(order), visited: new Set<string>() },
    sccCollectStep(inEdges),
  );
};

const isNotNode = (target: string) => (node: string) => node !== target;

const countReachableFrom =
  (outEdges: ReadonlyMap<string, ReadonlySet<string>>) =>
  (start: string): readonly [string, number] => {
    const initialNeighbors = RA.filter(isNotNode(start))(getSetOrEmpty(outEdges)(start));
    const reachable = bfsCollect({
      initialQueue: initialNeighbors,
      initialVisited: new Set([start, ...initialNeighbors]),
      edges: outEdges,
    });
    return [start, reachable.length];
  };

const computeTransitiveCounts = ({
  nodes,
  outEdges,
}: {
  readonly nodes: ReadonlyArray<string>;
  readonly outEdges: ReadonlyMap<string, ReadonlySet<string>>;
}) => new Map(RA.map(countReachableFrom(outEdges))(nodes));

const lookupDepth = (depthMap: ReadonlyMap<number, number>) => (sccIdx: number) =>
  O.getOrElse(() => 0)(liftNullable(depthMap.get(sccIdx)));

const getNumberSetOrEmpty = (edges: ReadonlyMap<number, ReadonlySet<number>>) => (key: number) =>
  Array.from(
    O.getOrElse((): ReadonlySet<number> => new Set())(liftNullable(edges.get(key))),
  );

type SccDepthContext = {
  readonly sccOut: ReadonlyMap<number, ReadonlySet<number>>;
  readonly depthMap: ReadonlyMap<number, number>;
};

const stepSccDepth =
  ({ sccOut, depthMap }: SccDepthContext) =>
  ({ head, tail }: { readonly head: number; readonly tail: ReadonlyArray<number> }): ReadonlyMap<
    number,
    number
  > => {
    const children = getNumberSetOrEmpty(sccOut)(head);
    const childDepths = RA.map(lookupDepth(depthMap))(children);
    const maxChild = O.getOrElse(() => -1)(RA.head(RA.sortBy([descNumberOrd])(childDepths)));
    return computeSccDepths({
      sccOut,
      depthMap: new Map([...depthMap, [head, maxChild + 1]]),
    })(tail);
  };

const computeSccDepths =
  ({ sccOut, depthMap }: SccDepthContext) =>
  (remaining: ReadonlyArray<number>): ReadonlyMap<number, number> =>
    O.match(() => depthMap, stepSccDepth({ sccOut, depthMap }))(uncons(remaining));

const pairNodeWithScc = (idx: number) => (n: string) => [n, idx] as const;

const mapSccToPairs = ([idx, scc]: readonly [number, ReadonlyArray<string>]) =>
  RA.map(pairNodeWithScc(idx))(scc);

const lookupSccForNode = (nodeToScc: ReadonlyMap<string, number>) => (n: string) =>
  liftNullable(nodeToScc.get(n));

const isNotSelfScc = (idx: number) => (t: number) => t !== idx;

const buildSccOutEntry =
  ({
    nodeToScc,
    outEdges,
  }: {
    readonly nodeToScc: ReadonlyMap<string, number>;
    readonly outEdges: ReadonlyMap<string, ReadonlySet<string>>;
  }) =>
  ([idx, scc]: readonly [number, ReadonlyArray<string>]): readonly [number, ReadonlySet<number>] => {
    const outNodes = RA.chain(getSetOrEmpty(outEdges))(scc);
    const targets = RA.filterMap(lookupSccForNode(nodeToScc))(outNodes);
    return [idx, new Set(RA.filter(isNotSelfScc(idx))(targets))];
  };

const lookupNodeLayer =
  ({
    nodeToScc,
    sccDepth,
  }: {
    readonly nodeToScc: ReadonlyMap<string, number>;
    readonly sccDepth: ReadonlyMap<number, number>;
  }) =>
  (node: string): readonly [string, number] => [
    node,
    O.match(() => 0, lookupDepth(sccDepth))(liftNullable(nodeToScc.get(node))),
  ];

const computeLayers = ({
  nodes,
  sccs,
  outEdges,
}: {
  readonly nodes: ReadonlyArray<string>;
  readonly sccs: ReadonlyArray<ReadonlyArray<string>>;
  readonly outEdges: ReadonlyMap<string, ReadonlySet<string>>;
}) => {
  const indexedSccs = B.match(
    () => [] satisfies ReadonlyArray<readonly [number, ReadonlyArray<string>]>,
    () => RA.zip(RA.range(0, sccs.length - 1), sccs),
  )(sccs.length > 0);
  const nodeToScc = new Map<string, number>(RA.chain(mapSccToPairs)(indexedSccs));
  const sccOut = new Map<number, ReadonlySet<number>>(
    RA.map(buildSccOutEntry({ nodeToScc, outEdges }))(indexedSccs),
  );
  const revIndices = B.match(
    () => [] satisfies ReadonlyArray<number>,
    () => reverseArray(RA.range(0, sccs.length - 1)),
  )(sccs.length > 0);
  const sccDepth = computeSccDepths({ sccOut, depthMap: new Map() })(revIndices);
  return new Map(RA.map(lookupNodeLayer({ nodeToScc, sccDepth }))(nodes));
};

const isInSet = (set: ReadonlySet<string>) => (item: string) => set.has(item);

const computeNonEmptyJaccard = ({
  a,
  b,
}: {
  readonly a: ReadonlySet<string>;
  readonly b: ReadonlySet<string>;
}) => {
  const intersection = RA.filter(isInSet(b))(Array.from(a)).length;
  const union = a.size + b.size - intersection;
  return B.match(
    () => intersection / union,
    () => 0,
  )(union === 0);
};

const jaccardSimilarity = ({
  a,
  b,
}: {
  readonly a: ReadonlySet<string>;
  readonly b: ReadonlySet<string>;
}) => B.match(() => computeNonEmptyJaccard({ a, b }), () => 0)(a.size === 0 && b.size === 0);

const checkNonEmptyIntersection = ({
  a,
  b,
}: {
  readonly a: ReadonlyArray<string>;
  readonly b: ReadonlyArray<string>;
}) => RA.some(isInSet(new Set(b)))(a);

const hasIntersection = ({
  a,
  b,
}: {
  readonly a: ReadonlyArray<string>;
  readonly b: ReadonlyArray<string>;
}) => B.match(() => checkNonEmptyIntersection({ a, b }), () => false)(a.length === 0 || b.length === 0);

const isoFilePath = iso<FilePath>();
const isoRelativePath = iso<RelativePath>();
const isoDirectoryPath = iso<DirectoryPath>();
const isoModuleCount = iso<ModuleCount>();
const isoClusterCount = iso<ClusterCount>();
const isoCohesionScore = iso<CohesionScore>();
const isoJaccardScore = iso<JaccardScore>();
const isoEdgeCount = iso<EdgeCount>();
const isoCycleCount = iso<CycleCount>();
const isoDirectoryCount = iso<DirectoryCount>();
const isoDepthCount = iso<DepthCount>();
const isoDependencyCount = iso<DependencyCount>();
const isoLayerIndex = iso<LayerIndex>();

const isCohesionCandidate = (mod: ResolvedModuleData) => mod.moduleKind === 'standard';

const getModuleDirectory = (mod: ResolvedModuleData) => isoDirectoryPath.unwrap(mod.directory);

const getModuleFilePath = (mod: ResolvedModuleData) => isoFilePath.unwrap(mod.filePath);

const getModuleRelativePath = (mod: ResolvedModuleData) => isoRelativePath.unwrap(mod.relativePath);

const getModuleDomainExtDeps = (mod: ResolvedModuleData) => mod.domainExternalDependencies;

const dirEntryOrd = Ord.contramap(getTupleFirstString)(S.Ord);

const getClusterSize = (c: DirectoryCluster) => c.modules.length;

const clusterLenDescOrd = Ord.contramap(getClusterSize)(descNumberOrd);

const getClusterFirstModule = (c: DirectoryCluster) => O.getOrElse(() => '')(RA.head(c.modules));

const clusterFirstModOrd = Ord.contramap(getClusterFirstModule)(S.Ord);

const isBarrelModuleKind = (k: ModuleKind) => k === 'barrel' || k === 'barrel-type-only';
const isTypeOnlyModuleKind = (k: ModuleKind) => k === 'type-only' || k === 'barrel-type-only';

const isNonBarrelMod = (mod: ResolvedModuleData) => !isBarrelModuleKind(mod.moduleKind);

const isNonBarrelCaller =
  (modules: ReadonlyMap<string, ResolvedModuleData>) => (callerPath: string) =>
    O.match(() => false, isNonBarrelMod)(liftNullable(modules.get(callerPath)));

const collectCallersEntry =
  ({
    modules,
    runtimeInEdges,
  }: {
    readonly modules: ReadonlyMap<string, ResolvedModuleData>;
    readonly runtimeInEdges: ReadonlyMap<string, ReadonlySet<string>>;
  }) =>
  (mod: ResolvedModuleData): readonly [string, ReadonlySet<string>] => [
    getModuleFilePath(mod),
    new Set(
      RA.filter(isNonBarrelCaller(modules))(getSetOrEmpty(runtimeInEdges)(getModuleFilePath(mod))),
    ),
  ];

const setContainsTarget = (to: string) => (s: ReadonlySet<string>) => s.has(to);

const hasDirectedEdgeClean =
  (edges: ReadonlyMap<string, ReadonlySet<string>>) =>
  ({ from, to }: { readonly from: string; readonly to: string }) =>
    O.getOrElse(() => false)(O.map(setContainsTarget(to))(liftNullable(edges.get(from))));

type CohesionClusterState = {
  readonly remaining: ReadonlyArray<string>;
  readonly visited: ReadonlySet<string>;
};

const advanceCohesionCluster =
  ({ adj, state }: { readonly adj: ReadonlyMap<string, ReadonlySet<string>>; readonly state: CohesionClusterState }) =>
  ({ head, tail }: { readonly head: string; readonly tail: ReadonlyArray<string> }) => {
    const comp = bfsCollect({
      initialQueue: [head],
      initialVisited: new Set([...state.visited, head]),
      edges: adj,
    });
    return [
      comp,
      {
        remaining: tail,
        visited: new Set([...state.visited, ...comp]),
      },
    ] as const;
  };

const cohesionClusterStep =
  (adj: ReadonlyMap<string, ReadonlySet<string>>) =>
  (state: CohesionClusterState): O.Option<readonly [ReadonlyArray<string>, CohesionClusterState]> =>
    O.map(advanceCohesionCluster({ adj, state }))(
      uncons(RA.dropLeftWhile(isVisited(state.visited))(state.remaining)),
    );

const lookupModule = (modules: ReadonlyMap<string, ResolvedModuleData>) => (f: string) =>
  liftNullable(modules.get(f));

const lookupModuleRelPath = (modules: ReadonlyMap<string, ResolvedModuleData>) => (c: string) =>
  O.map(getModuleRelativePath)(liftNullable(modules.get(c)));

const buildDirectoryCluster =
  ({
    modules,
    callersByMod,
  }: {
    readonly modules: ReadonlyMap<string, ResolvedModuleData>;
    readonly callersByMod: ReadonlyMap<string, ReadonlySet<string>>;
  }) =>
  (compFiles: ReadonlyArray<string>): DirectoryCluster => {
    const compMods = RA.filterMap(lookupModule(modules))(compFiles);
    const sharedDependencies = RA.sortBy([S.Ord])(
      RA.uniq(S.Eq)(RA.chain(getModuleDomainExtDeps)(compMods)),
    );
    const callerFiles = RA.uniq(S.Eq)(RA.chain(getSetOrEmpty(callersByMod))(compFiles));
    const callers = RA.sortBy([S.Ord])(
      RA.uniq(S.Eq)(RA.filterMap(lookupModuleRelPath(modules))(callerFiles)),
    );
    return {
      modules: RA.sortBy([S.Ord])(RA.map(getModuleRelativePath)(compMods)),
      sharedDependencies,
      callers,
    };
  };

const pairWithFirst = (i: number) => (j: number) => [i, j] as const;

const expandPairsForI = (len: number) => (i: number) =>
  RA.map(pairWithFirst(i))(RA.range(i + 1, len - 1));

const buildPairIndices = (len: number) =>
  B.match(
    () => [] satisfies ReadonlyArray<readonly [number, number]>,
    () => RA.chain(expandPairsForI(len))(RA.range(0, len - 2)),
  )(len >= 2);

const isIntraDirTarget =
  ({ dirFileSet, sourceFilePath }: { readonly dirFileSet: ReadonlySet<string>; readonly sourceFilePath: string }) =>
  (target: string) =>
    dirFileSet.has(target) && target !== sourceFilePath;

const collectIntraDirTargets =
  ({
    dirFileSet,
    runtimeOutEdges,
  }: {
    readonly dirFileSet: ReadonlySet<string>;
    readonly runtimeOutEdges: ReadonlyMap<string, ReadonlySet<string>>;
  }) =>
  (m: ResolvedModuleData) =>
    RA.filter(isIntraDirTarget({ dirFileSet, sourceFilePath: getModuleFilePath(m) }))(
      getSetOrEmpty(runtimeOutEdges)(getModuleFilePath(m)),
    );

type ModPair = {
  readonly m1: ResolvedModuleData;
  readonly m2: ResolvedModuleData;
};

const makeModPair = (m1: ResolvedModuleData) => (m2: ResolvedModuleData): ModPair => ({ m1, m2 });

const pairWithSecondMod =
  ({ dirMods, j }: { readonly dirMods: ReadonlyArray<ResolvedModuleData>; readonly j: number }) =>
  (m1: ResolvedModuleData) =>
    O.map(makeModPair(m1))(RA.lookup(j)(dirMods));

const lookupModPair =
  (dirMods: ReadonlyArray<ResolvedModuleData>) =>
  ([i, j]: readonly [number, number]) =>
    O.chain(pairWithSecondMod({ dirMods, j }))(RA.lookup(i)(dirMods));

type PairAnalysis = {
  readonly jaccardOpt: O.Option<number>;
  readonly edgeOpt: O.Option<readonly [string, string]>;
};

const analyzeModPair =
  ({
    callersByMod,
    runtimeOutEdges,
  }: {
    readonly callersByMod: ReadonlyMap<string, ReadonlySet<string>>;
    readonly runtimeOutEdges: ReadonlyMap<string, ReadonlySet<string>>;
  }) =>
  ({ m1, m2 }: ModPair): PairAnalysis => {
    const f1 = getModuleFilePath(m1);
    const f2 = getModuleFilePath(m2);
    const c1 = O.getOrElse((): ReadonlySet<string> => new Set())(
      liftNullable(callersByMod.get(f1)),
    );
    const c2 = O.getOrElse((): ReadonlySet<string> => new Set())(
      liftNullable(callersByMod.get(f2)),
    );
    const jaccard = jaccardSimilarity({ a: c1, b: c2 });
    const hasCallers = c1.size > 0 || c2.size > 0;
    const intraEdge =
      hasDirectedEdgeClean(runtimeOutEdges)({ from: f1, to: f2 }) ||
      hasDirectedEdgeClean(runtimeOutEdges)({ from: f2, to: f1 });
    const sharedDomainType = hasIntersection({
      a: m1.referencedDomainTypes,
      b: m2.referencedDomainTypes,
    });
    const sharedExternalDep = hasIntersection({
      a: m1.domainExternalDependencies,
      b: m2.domainExternalDependencies,
    });
    const connected = intraEdge || sharedDomainType || sharedExternalDep || jaccard >= 0.25;
    return {
      jaccardOpt: B.match(
        () => O.none,
        () => O.some(jaccard),
      )(hasCallers),
      edgeOpt: B.match(
        () => O.none,
        () => O.some([f1, f2] as const),
      )(connected),
    };
  };

const extractJaccardOpt = (p: PairAnalysis) => p.jaccardOpt;

const extractEdgeOpt = (p: PairAnalysis) => p.edgeOpt;

const matchNeighborInPair = (f: string) => ([m1, m2]: readonly [string, string]) =>
  B.match(
    () =>
      B.match(
        () => O.none,
        () => O.some(m1),
      )(m2 === f),
    () => O.some(m2),
  )(m1 === f);

const buildAdjEntry =
  (connectedPairs: ReadonlyArray<readonly [string, string]>) =>
  (f: string): readonly [string, ReadonlySet<string>] => [
    f,
    new Set(RA.filterMap(matchNeighborInPair(f))(connectedPairs)),
  ];

const computeDirectoryMetric =
  ({
    modules,
    runtimeOutEdges,
    runtimeInEdges,
  }: {
    readonly modules: ReadonlyMap<string, ResolvedModuleData>;
    readonly runtimeOutEdges: ReadonlyMap<string, ReadonlySet<string>>;
    readonly runtimeInEdges: ReadonlyMap<string, ReadonlySet<string>>;
  }) =>
  ([directory, dirMods]: readonly [
    string,
    NEA.NonEmptyArray<ResolvedModuleData>,
  ]): DirectoryCohesionMetric => {
    const dirFiles = RA.map(getModuleFilePath)(dirMods);
    const dirFileSet = new Set(dirFiles);
    const callersByMod = new Map(
      RA.map(collectCallersEntry({ modules, runtimeInEdges }))(dirMods),
    );
    const intraDirectoryEdges = RA.chain(
      collectIntraDirTargets({ dirFileSet, runtimeOutEdges }),
    )(dirMods).length;

    const pairs = RA.filterMap(lookupModPair(dirMods))(buildPairIndices(dirMods.length));
    const pairAnalyses = RA.map(analyzeModPair({ callersByMod, runtimeOutEdges }))(pairs);
    const jaccardValues = RA.filterMap(extractJaccardOpt)(pairAnalyses);
    const jaccardSum = M.concatAll(N.MonoidSum)(jaccardValues);
    const averageCallerJaccard = B.match(
      () => Number((jaccardSum / jaccardValues.length).toFixed(3)),
      () => 0,
    )(jaccardValues.length === 0);

    const connectedPairs = RA.filterMap(extractEdgeOpt)(pairAnalyses);
    const adj = new Map<string, ReadonlySet<string>>(
      RA.map(buildAdjEntry(connectedPairs))(dirFiles),
    );

    const rawClusters = RA.unfold(
      { remaining: dirFiles, visited: new Set<string>() },
      cohesionClusterStep(adj),
    );
    const clusters = RA.sortBy([clusterLenDescOrd, clusterFirstModOrd])(
      RA.map(buildDirectoryCluster({ modules, callersByMod }))(rawClusters),
    );
    const distinctExternalDeps = RA.sortBy([S.Ord])(
      RA.uniq(S.Eq)(RA.chain(getModuleDomainExtDeps)(dirMods)),
    );
    const cohesionScore = B.match(
      () => Number((1 - (clusters.length - 1) / (dirMods.length - 1)).toFixed(3)),
      () => 1,
    )(dirMods.length <= 1);

    return {
      directory: isoDirectoryPath.wrap(directory),
      moduleCount: isoModuleCount.wrap(dirMods.length),
      clusterCount: isoClusterCount.wrap(clusters.length),
      cohesionScore: isoCohesionScore.wrap(cohesionScore),
      averageCallerJaccard: isoJaccardScore.wrap(averageCallerJaccard),
      intraDirectoryEdges: isoEdgeCount.wrap(intraDirectoryEdges),
      distinctExternalDeps,
      clusters,
    };
  };

const hasMinDirModules =
  (minDirModules: number) =>
  ([, mods]: readonly [string, NEA.NonEmptyArray<ResolvedModuleData>]) =>
    mods.length >= minDirModules;

const computeDirectoryCohesion = ({
  modules,
  runtimeOutEdges,
  runtimeInEdges,
  minDirModules,
}: {
  readonly modules: ReadonlyMap<string, ResolvedModuleData>;
  readonly runtimeOutEdges: ReadonlyMap<string, ReadonlySet<string>>;
  readonly runtimeInEdges: ReadonlyMap<string, ReadonlySet<string>>;
  readonly minDirModules: number;
}) => {
  const candidates = RA.filter(isCohesionCandidate)(Array.from(modules.values()));
  const byDir = RR.toEntries(NEA.groupBy(getModuleDirectory)([...candidates]));
  const eligibleDirs = RA.sortBy([dirEntryOrd])(
    RA.filter(hasMinDirModules(minDirModules))(byDir),
  );
  return RA.map(computeDirectoryMetric({ modules, runtimeOutEdges, runtimeInEdges }))(eligibleDirs);
};

const sourceFileOrd = Ord.contramap((sf: ts.SourceFile) => sf.fileName)(S.Ord);

const isNonTargetEligible = ({
  projectBaseDir,
  excludePatterns,
  abs,
}: {
  readonly projectBaseDir: string;
  readonly excludePatterns: ReadonlyArray<string>;
  readonly abs: string;
}) => {
  const relToBase = path.relative(projectBaseDir, abs);
  return (
    !isDefaultTestOrFixtureFile(relToBase) &&
    !matchesExcludePatterns({ filePath: abs, excludePatterns })
  );
};

const isEligibleSourceFile =
  ({
    targetSet,
    projectBaseDir,
    excludePatterns,
  }: {
    readonly targetSet: ReadonlySet<string>;
    readonly projectBaseDir: string;
    readonly excludePatterns: ReadonlyArray<string>;
  }) =>
  (sf: ts.SourceFile) => {
    const abs = path.resolve(sf.fileName);
    const isValidTs =
      !sf.isDeclarationFile &&
      !abs.includes(`${path.sep}node_modules${path.sep}`) &&
      isTsSourceFile(abs);
    return B.match(
      () => false,
      () =>
        B.match(
          () => isNonTargetEligible({ projectBaseDir, excludePatterns, abs }),
          () => true,
        )(targetSet.has(abs)),
    )(isValidTs);
  };

const getBindingName = (b: BindingInfo) => isoSymbolName.unwrap(b.name);

const getBindingSignature = (b: BindingInfo) => isoTypeSignature.unwrap(b.signature);

const analyzePrimaryExport =
  ({ checker, inspector }: { readonly checker: ts.TypeChecker; readonly inspector: TypeInspector }) =>
  (binding: BindingInfo) => {
    const exportType = checker.getTypeAtLocation(binding.declaration);
    return {
      domainNames: collectDomainTypeNamesFromType({
        checker,
        type: exportType,
        visited: new Set(),
        depth: 0,
      }),
      exportedEffects: detectDeepEffects({ inspector, type: exportType, depth: 0 }),
      primitiveInputKind: extractPrimitiveInputKind(checker)(exportType),
    };
  };

const extractTypeDeclDomainName =
  (checker: ts.TypeChecker) => (td: ModuleIR['typeDeclarations'][number]) => {
    const tdType = checker.getTypeAtLocation(td.node);
    const isDomainType =
      tdType.getCallSignatures().length === 0 && !isBuiltinOrContainerTypeName(td.name);
    return B.match(
      () => O.none,
      () => O.some(td.name),
    )(isDomainType);
  };

const resolveModuleEntry =
  ({
    program,
    checker,
    inspector,
    targetSet,
    rootDir,
    inScopeFileSet,
    resolutionCache,
    preExtractedIRs,
  }: {
    readonly program: ts.Program;
    readonly checker: ts.TypeChecker;
    readonly inspector: TypeInspector;
    readonly targetSet: ReadonlySet<string>;
    readonly rootDir: string;
    readonly inScopeFileSet: ReadonlySet<string>;
    readonly resolutionCache: ts.ModuleResolutionCache;
    readonly preExtractedIRs: ReadonlyMap<string, ModuleIR>;
  }) =>
  (sf: ts.SourceFile): readonly [string, ResolvedModuleData] => {
    const abs = path.resolve(sf.fileName);
    const ir = O.getOrElse(() => extractModuleIR({ sourceFile: sf, checker, inspector }))(
      liftNullable(preExtractedIRs.get(abs)),
    );
    const { isBarrel, isTypeOnlyModule } = detectBarrelAndTypeOnly(sf)(ir);
    const primaryExport = findPrimaryExportedBinding(ir);
    const refs = resolveModuleReferences({ program, inScopeFiles: inScopeFileSet, resolutionCache })(
      sf,
    );

    const exportAnalysis = O.match(
      () => ({
        domainNames: [] satisfies ReadonlyArray<string>,
        exportedEffects: [] satisfies ReadonlyArray<string>,
        primitiveInputKind: O.none satisfies O.Option<PrimitiveKind>,
      }),
      analyzePrimaryExport({ checker, inspector }),
    )(primaryExport);

    const typeDeclDomainNames = RA.filterMap(extractTypeDeclDomainName(checker))(
      ir.typeDeclarations,
    );

    return [
      abs,
      {
        filePath: isoFilePath.wrap(abs),
        relativePath: isoRelativePath.wrap(
          toRelativePosixPath({
            rootDir: iso<RootDir>().wrap(rootDir),
            filePath: isoFilePath.wrap(abs),
          }),
        ),
        directory: isoDirectoryPath.wrap(
          toRelativeDirectory({
            rootDir: iso<RootDir>().wrap(rootDir),
            filePath: isoFilePath.wrap(abs),
          }),
        ),
        sourceFile: sf,
        ir,
        scope: B.match<ModuleScope>(
          () => 'dependency',
          () => 'target',
        )(targetSet.has(abs)),
        moduleKind: B.match<ModuleKind>(
          () =>
            B.match<ModuleKind>(
              () =>
                B.match<ModuleKind>(
                  () => 'standard',
                  () => 'type-only',
                )(isTypeOnlyModule),
              () => 'barrel',
            )(isBarrel),
          () => 'barrel-type-only',
        )(isBarrel && isTypeOnlyModule),
        exportedFunction: O.map(getBindingName)(primaryExport),
        exportedSignature: O.map(getBindingSignature)(primaryExport),
        exportedEffects: exportAnalysis.exportedEffects,
        primitiveInputKind: exportAnalysis.primitiveInputKind,
        internalImports: refs.internalImports,
        externalDependencies: refs.externalDependencies,
        domainExternalDependencies: refs.domainExternalDependencies,
        referencedDomainTypes: RA.sortBy([S.Ord])(
          RA.uniq(S.Eq)([...exportAnalysis.domainNames, ...typeDeclDomainNames]),
        ),
      },
    ];
  };

type RawEdgeRecord = {
  readonly fromFile: string;
  readonly toFile: string;
  readonly isTypeOnly: boolean;
  readonly edge: ProjectEdge;
};

const buildSingleEdgeRecord =
  ({
    mod,
    imp,
  }: {
    readonly mod: ResolvedModuleData;
    readonly imp: ResolvedModuleData['internalImports'][number];
  }) =>
  (targetMod: ResolvedModuleData): RawEdgeRecord => ({
    fromFile: isoFilePath.unwrap(mod.filePath),
    toFile: imp.targetFile,
    isTypeOnly: imp.isTypeOnly,
    edge: {
      from: isoFilePath.wrap(isoRelativePath.unwrap(mod.relativePath)),
      to: isoFilePath.wrap(isoRelativePath.unwrap(targetMod.relativePath)),
      isTypeOnly: imp.isTypeOnly,
      importedSymbols: imp.importedSymbols,
    },
  });

const buildEdgeForImport =
  ({ modules, mod }: { readonly modules: ReadonlyMap<string, ResolvedModuleData>; readonly mod: ResolvedModuleData }) =>
  (imp: ResolvedModuleData['internalImports'][number]) =>
    O.map(buildSingleEdgeRecord({ mod, imp }))(liftNullable(modules.get(imp.targetFile)));

const buildEdgesForModule =
  (modules: ReadonlyMap<string, ResolvedModuleData>) => (mod: ResolvedModuleData) =>
    RA.filterMap(buildEdgeForImport({ modules, mod }))(mod.internalImports);

const buildEdgePairs = (modules: ReadonlyMap<string, ResolvedModuleData>) =>
  RA.chain(buildEdgesForModule(modules))(Array.from(modules.values()));

const getPairKey = ([k]: readonly [string, string]) => k;

const getPairTarget = ([, v]: readonly [string, string]) => v;

const buildEdgeSetEntry =
  (grouped: RR.ReadonlyRecord<string, NEA.NonEmptyArray<readonly [string, string]>>) =>
  (f: string): readonly [string, ReadonlySet<string>] => [
    f,
    new Set(
      RA.map(getPairTarget)(
        O.getOrElse((): ReadonlyArray<readonly [string, string]> => [])(
          RR.lookup(f)(grouped),
        ),
      ),
    ),
  ];

const groupTargetsByKey =
  (allFiles: ReadonlyArray<string>) =>
  (pairs: ReadonlyArray<readonly [string, string]>): ReadonlyMap<string, ReadonlySet<string>> => {
    const grouped = NEA.groupBy(getPairKey)([...pairs]);
    return new Map(RA.map(buildEdgeSetEntry(grouped))(allFiles));
  };

const identityFileName = (f: string) => f;

const resolveSourceFilePath = (sf: ts.SourceFile) => path.resolve(sf.fileName);

const getRawEdge = (r: RawEdgeRecord) => r.edge;

const isRuntimeRawEdge = (r: RawEdgeRecord) => !r.isTypeOnly;

const toForwardPair = (r: RawEdgeRecord) => [r.fromFile, r.toFile] as const;

const toReversePair = (r: RawEdgeRecord) => [r.toFile, r.fromFile] as const;

const isCycleScc = (scc: ReadonlyArray<string>) => scc.length >= 2;

const sortStrings = RA.sortBy([S.Ord]);

const getSetSize = (s: ReadonlySet<string>) => s.size;

const buildModuleNodeFromData =
  ({
    f,
    allInEdges,
    allOutEdges,
    layers,
    transitiveCounts,
  }: {
    readonly f: string;
    readonly allInEdges: ReadonlyMap<string, ReadonlySet<string>>;
    readonly allOutEdges: ReadonlyMap<string, ReadonlySet<string>>;
    readonly layers: ReadonlyMap<string, number>;
    readonly transitiveCounts: ReadonlyMap<string, number>;
  }) =>
  (mod: ResolvedModuleData): ProjectModuleNode => {
    const inDegree = O.getOrElse(() => 0)(O.map(getSetSize)(liftNullable(allInEdges.get(f))));
    const outDegree = O.getOrElse(() => 0)(O.map(getSetSize)(liftNullable(allOutEdges.get(f))));
    const layer = O.getOrElse(() => 0)(liftNullable(layers.get(f)));
    return {
      filePath: mod.filePath,
      relativePath: mod.relativePath,
      directory: mod.directory,
      scope: mod.scope,
      moduleKind: mod.moduleKind,
      role: B.match<ModuleRole>(
        () => 'internal',
        () => 'entrypoint',
      )(inDegree === 0 && !isTypeOnlyModuleKind(mod.moduleKind)),
      exportedFunction: mod.exportedFunction,
      exportedSignature: mod.exportedSignature,
      effects: mod.exportedEffects,
      inDegree: isoModuleCount.wrap(inDegree),
      outDegree: isoModuleCount.wrap(outDegree),
      transitiveDependencyCount: isoDependencyCount.wrap(
        O.getOrElse(() => 0)(liftNullable(transitiveCounts.get(f))),
      ),
      externalDependencies: mod.externalDependencies,
      domainExternalDependencies: mod.domainExternalDependencies,
      referencedDomainTypes: mod.referencedDomainTypes,
      layer: isoLayerIndex.wrap(layer),
    };
  };

const buildNodeForFile =
  ({
    modules,
    allInEdges,
    allOutEdges,
    layers,
    transitiveCounts,
  }: {
    readonly modules: ReadonlyMap<string, ResolvedModuleData>;
    readonly allInEdges: ReadonlyMap<string, ReadonlySet<string>>;
    readonly allOutEdges: ReadonlyMap<string, ReadonlySet<string>>;
    readonly layers: ReadonlyMap<string, number>;
    readonly transitiveCounts: ReadonlyMap<string, number>;
  }) =>
  (f: string) =>
    O.map(buildModuleNodeFromData({ f, allInEdges, allOutEdges, layers, transitiveCounts }))(
      liftNullable(modules.get(f)),
    );

const toNodeEntry = (node: ProjectModuleNode) => [isoFilePath.unwrap(node.filePath), node] as const;

const getNodeLayer = (n: ProjectModuleNode) => isoLayerIndex.unwrap(n.layer);

const isNodeBarrel = (n: ProjectModuleNode) => isBarrelModuleKind(n.moduleKind);

const getNodeDirectory = (n: ProjectModuleNode) => isoDirectoryPath.unwrap(n.directory);

export const buildProjectDag = (({
  program,
  checker,
  inspector,
  targetFiles,
  projectBaseDir,
  excludePatterns,
  minDirModules,
  preExtractedIRs,
}) => {
  const targetSet = new Set(RA.map(path.resolve)(targetFiles));
  const selectedSourceFiles = RA.sortBy([sourceFileOrd])(
    RA.filter(isEligibleSourceFile({ targetSet, projectBaseDir, excludePatterns }))(
      program.getSourceFiles(),
    ),
  );
  const inScopeFiles = RA.map(resolveSourceFilePath)(selectedSourceFiles);
  const inScopeFileSet = new Set(inScopeFiles);
  const rootDir = computeCommonRootDir(inScopeFiles);
  const resolutionCache = ts.createModuleResolutionCache(
    projectBaseDir,
    identityFileName,
    program.getCompilerOptions(),
  );

  const modules = new Map(
    RA.map(
      resolveModuleEntry({
        program,
        checker,
        inspector,
        targetSet,
        rootDir,
        inScopeFileSet,
        resolutionCache,
        preExtractedIRs,
      }),
    )(selectedSourceFiles),
  );

  const allFiles = sortStrings(Array.from(modules.keys()));
  const rawEdges = buildEdgePairs(modules);
  const edges = RA.map(getRawEdge)(rawEdges);

  const runtimeEdges = RA.filter(isRuntimeRawEdge)(rawEdges);
  const buildEdgeMap = groupTargetsByKey(allFiles);
  const allOutEdges = buildEdgeMap(RA.map(toForwardPair)(rawEdges));
  const allInEdges = buildEdgeMap(RA.map(toReversePair)(rawEdges));
  const runtimeOutEdges = buildEdgeMap(RA.map(toForwardPair)(runtimeEdges));
  const runtimeInEdges = buildEdgeMap(RA.map(toReversePair)(runtimeEdges));

  const sccs = computeSccs({ nodes: allFiles, outEdges: allOutEdges, inEdges: allInEdges });
  const cycles = RA.map(sortStrings)(RA.filter(isCycleScc)(sccs));

  const transitiveCounts = computeTransitiveCounts({
    nodes: allFiles,
    outEdges: runtimeOutEdges,
  });
  const layers = computeLayers({ nodes: allFiles, sccs, outEdges: runtimeOutEdges });
  const directories = computeDirectoryCohesion({
    modules,
    runtimeOutEdges,
    runtimeInEdges,
    minDirModules,
  });

  const nodes = RA.filterMap(
    buildNodeForFile({ modules, allInEdges, allOutEdges, layers, transitiveCounts }),
  )(allFiles);

  const nodeByFile = new Map(RA.map(toNodeEntry)(nodes));
  const maxDepth = O.getOrElse(() => 0)(
    RA.head(RA.sortBy([descNumberOrd])(RA.map(getNodeLayer)(nodes))),
  );
  const barrelCount = RA.filter(isNodeBarrel)(nodes).length;

  const summary: ProjectDagSummary = {
    analyzedModuleCount: isoModuleCount.wrap(nodes.length),
    targetFileCount: isoModuleCount.wrap(targetFiles.length),
    edgeCount: isoEdgeCount.wrap(edges.length),
    cycleCount: isoCycleCount.wrap(cycles.length),
    directoryCount: isoDirectoryCount.wrap(new Set(RA.map(getNodeDirectory)(nodes)).size),
    maxDepth: isoDepthCount.wrap(maxDepth),
    barrelCount: isoModuleCount.wrap(barrelCount),
  };

  return {
    rootDir,
    modules,
    nodes,
    nodeByFile,
    edges,
    runtimeOutEdges,
    runtimeInEdges,
    allOutEdges,
    allInEdges,
    cycles,
    directories,
    summary,
  };
}) satisfies BuildProjectDag;
