import * as O from 'fp-ts/lib/Option.js';
import * as path from 'node:path';
import * as ts from 'typescript';
import { extractModuleIR } from '../ir/moduleGraph.js';
import type {
  BuiltProjectDag,
  DirectoryCluster,
  DirectoryCohesionMetric,
  ProjectDagSummary,
  ProjectEdge,
  ProjectModuleNode,
  ResolvedModuleData,
} from '../model/projectReport.js';
import type { BindingInfo, ModuleIR, TypeInspector } from '../model/report.js';
import {
  computeCommonRootDir,
  isDefaultTestOrFixtureFile,
  isTsSourceFile,
  matchesExcludePatterns,
  toRelativeDirectory,
  toRelativePosixPath,
} from './fileDiscovery.js';

const FP_CORE_PACKAGES = new Set([
  'fp-ts',
  'monocle-ts',
  'newtype-ts',
  'ts-pattern',
]);

const BUILTIN_AND_CONTAINER_TYPE_NAMES = new Set([
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
]);

export type BuildProjectDagInput = {
  readonly program: ts.Program;
  readonly checker: ts.TypeChecker;
  readonly inspector: TypeInspector;
  readonly targetFiles: ReadonlyArray<string>;
  readonly projectBaseDir: string;
  readonly excludePatterns: ReadonlyArray<string>;
  readonly minDirModules: number;
  readonly preExtractedIRs?: ReadonlyMap<string, ModuleIR>;
};

const extractPackageName = (specifier: string): string => {
  if (specifier.startsWith('node:')) {
    return specifier;
  }
  if (specifier.startsWith('@')) {
    const parts = specifier.split('/');
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : specifier;
  }
  const slashIdx = specifier.indexOf('/');
  return slashIdx === -1 ? specifier : specifier.slice(0, slashIdx);
};

const isRelativeOrAbsoluteSpecifier = (specifier: string): boolean =>
  specifier.startsWith('.') || specifier.startsWith('/');

const collectDomainTypeNamesFromType = (
  checker: ts.TypeChecker,
  type: ts.Type,
  out: Set<string>,
  visited: Set<ts.Type>,
  depth: number,
): void => {
  if (depth > 3 || visited.has(type)) {
    return;
  }
  visited.add(type);

  const isFnType = type.getCallSignatures().length > 0;
  if (!isFnType) {
    const sym = type.aliasSymbol ?? type.getSymbol();
    if (sym !== undefined) {
      const name = sym.getName();
      if (name.length > 0 && !BUILTIN_AND_CONTAINER_TYPE_NAMES.has(name) && !name.startsWith('__')) {
        const declFile = sym.declarations?.[0]?.getSourceFile().fileName ?? '';
        if (!declFile.includes('node_modules/typescript/lib/')) {
          out.add(name);
        }
      }
    }
  }

  if (type.isUnionOrIntersection()) {
    for (const member of type.types) {
      collectDomainTypeNamesFromType(checker, member, out, visited, depth + 1);
    }
  }

  if ('target' in type && 'typeArguments' in type) {
    const args = checker.getTypeArguments(type as ts.TypeReference);
    for (const arg of args) {
      collectDomainTypeNamesFromType(checker, arg, out, visited, depth + 1);
    }
  }

  if (depth <= 2) {
    for (const sig of type.getCallSignatures()) {
      for (const param of sig.getParameters()) {
        const paramType = checker.getTypeOfSymbol(param);
        collectDomainTypeNamesFromType(checker, paramType, out, visited, depth + 1);
      }
      collectDomainTypeNamesFromType(checker, sig.getReturnType(), out, visited, depth + 1);
    }
  }
};

const detectDeepEffects = (
  inspector: TypeInspector,
  type: ts.Type,
  depth = 0,
): ReadonlyArray<string> => {
  if (depth > 4) {
    return ['Pure'];
  }
  const direct = inspector.detectEffects(type).filter((e) => e !== 'Pure');
  if (direct.length > 0) {
    return direct;
  }
  const nested = new Set<string>();
  for (const sig of type.getCallSignatures()) {
    const ret = sig.getReturnType();
    if (ret.getCallSignatures().length > 0) {
      for (const eff of detectDeepEffects(inspector, ret, depth + 1)) {
        if (eff !== 'Pure') {
          nested.add(eff);
        }
      }
    }
  }
  return nested.size > 0 ? Array.from(nested) : ['Pure'];
};

const extractPrimitiveInputKind = (
  checker: ts.TypeChecker,
  type: ts.Type,
): O.Option<'string' | 'number' | 'boolean'> => {
  const sigs = type.getCallSignatures();
  if (sigs.length !== 1) {
    return O.none;
  }
  const params = sigs[0]!.getParameters();
  if (params.length !== 1) {
    return O.none;
  }
  const paramType = checker.getTypeOfSymbol(params[0]!);
  if ((paramType.flags & ts.TypeFlags.StringLike) !== 0) {
    return O.some('string');
  }
  if ((paramType.flags & ts.TypeFlags.NumberLike) !== 0) {
    return O.some('number');
  }
  if ((paramType.flags & ts.TypeFlags.BooleanLike) !== 0) {
    return O.some('boolean');
  }
  return O.none;
};

const findPrimaryExportedBinding = (ir: ModuleIR): O.Option<BindingInfo> => {
  const found = ir.bindings.find((b) => b.isExported && b.kind !== 'other');
  return found !== undefined ? O.some(found) : O.none;
};

const detectBarrelAndTypeOnly = (
  sf: ts.SourceFile,
  ir: ModuleIR,
): { readonly isBarrel: boolean; readonly isTypeOnlyModule: boolean } => {
  let hasRuntimeReExport = false;
  let hasAnyReExport = false;

  for (const stmt of sf.statements) {
    if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier !== undefined) {
      hasAnyReExport = true;
      if (!stmt.isTypeOnly) {
        hasRuntimeReExport = true;
      }
    }
  }

  const hasLocalRuntimeBindings = ir.bindings.length > 0;
  const isBarrel = !hasLocalRuntimeBindings && hasAnyReExport;
  const isTypeOnlyModule = !hasLocalRuntimeBindings && !hasRuntimeReExport;
  return { isBarrel, isTypeOnlyModule };
};

const resolveModuleReferences = (
  sf: ts.SourceFile,
  program: ts.Program,
  inScopeFiles: ReadonlySet<string>,
  resolutionCache: ts.ModuleResolutionCache,
): {
  readonly internalImports: ReadonlyArray<{
    readonly targetFile: string;
    readonly isTypeOnly: boolean;
    readonly importedSymbols: ReadonlyArray<string>;
  }>;
  readonly externalDependencies: ReadonlyArray<string>;
  readonly domainExternalDependencies: ReadonlyArray<string>;
} => {
  const compilerOptions = program.getCompilerOptions();
  const internalByTarget = new Map<
    string,
    { isTypeOnly: boolean; importedSymbols: Set<string> }
  >();
  const externalSet = new Set<string>();

  const recordSpecifier = (
    specifier: string,
    isTypeOnly: boolean,
    symbols: ReadonlyArray<string>,
  ): void => {
    const resolved = ts.resolveModuleName(
      specifier,
      sf.fileName,
      compilerOptions,
      ts.sys,
      resolutionCache,
    );
    const resolvedFile = resolved.resolvedModule?.resolvedFileName
      ? path.resolve(resolved.resolvedModule.resolvedFileName)
      : undefined;

    if (resolvedFile !== undefined && inScopeFiles.has(resolvedFile) && resolvedFile !== path.resolve(sf.fileName)) {
      const existing = internalByTarget.get(resolvedFile);
      if (existing === undefined) {
        internalByTarget.set(resolvedFile, {
          isTypeOnly,
          importedSymbols: new Set(symbols),
        });
      } else {
        existing.isTypeOnly = existing.isTypeOnly && isTypeOnly;
        for (const sym of symbols) {
          existing.importedSymbols.add(sym);
        }
      }
      return;
    }

    if (!isRelativeOrAbsoluteSpecifier(specifier)) {
      externalSet.add(extractPackageName(specifier));
    }
  };

  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
      const specifier = stmt.moduleSpecifier.text;
      const clause = stmt.importClause;
      const isTypeOnly = clause?.isTypeOnly === true;
      const symbols: string[] = [];
      if (clause?.name !== undefined) {
        symbols.push(clause.name.text);
      }
      if (clause?.namedBindings !== undefined) {
        if (ts.isNamespaceImport(clause.namedBindings)) {
          symbols.push(`* as ${clause.namedBindings.name.text}`);
        } else if (ts.isNamedImports(clause.namedBindings)) {
          for (const el of clause.namedBindings.elements) {
            symbols.push((el.propertyName ?? el.name).text);
          }
        }
      }
      recordSpecifier(specifier, isTypeOnly, symbols);
    } else if (
      ts.isExportDeclaration(stmt) &&
      stmt.moduleSpecifier !== undefined &&
      ts.isStringLiteral(stmt.moduleSpecifier)
    ) {
      const specifier = stmt.moduleSpecifier.text;
      const symbols: string[] = [];
      if (stmt.exportClause !== undefined && ts.isNamedExports(stmt.exportClause)) {
        for (const el of stmt.exportClause.elements) {
          symbols.push((el.propertyName ?? el.name).text);
        }
      } else {
        symbols.push('*');
      }
      recordSpecifier(specifier, stmt.isTypeOnly, symbols);
    }
  }

  const internalImports = Array.from(internalByTarget.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([targetFile, data]) => ({
      targetFile,
      isTypeOnly: data.isTypeOnly,
      importedSymbols: Array.from(data.importedSymbols).sort(),
    }));

  const externalDependencies = Array.from(externalSet).sort();
  const domainExternalDependencies = externalDependencies.filter(
    (pkg) => !FP_CORE_PACKAGES.has(pkg),
  );

  return { internalImports, externalDependencies, domainExternalDependencies };
};

const computeTarjanSccs = (
  nodes: ReadonlyArray<string>,
  outEdges: ReadonlyMap<string, ReadonlySet<string>>,
): ReadonlyArray<ReadonlyArray<string>> => {
  let index = 0;
  const indices = new Map<string, number>();
  const lowlinks = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const sccs: string[][] = [];

  const strongConnect = (v: string): void => {
    indices.set(v, index);
    lowlinks.set(v, index);
    index += 1;
    stack.push(v);
    onStack.add(v);

    const neighbors = outEdges.get(v) ?? new Set<string>();
    for (const w of neighbors) {
      if (!indices.has(w)) {
        strongConnect(w);
        lowlinks.set(v, Math.min(lowlinks.get(v)!, lowlinks.get(w)!));
      } else if (onStack.has(w)) {
        lowlinks.set(v, Math.min(lowlinks.get(v)!, indices.get(w)!));
      }
    }

    if (lowlinks.get(v) === indices.get(v)) {
      const component: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        component.push(w);
      } while (w !== v);
      sccs.push(component);
    }
  };

  for (const node of nodes) {
    if (!indices.has(node)) {
      strongConnect(node);
    }
  }

  return sccs;
};

const computeTransitiveCounts = (
  nodes: ReadonlyArray<string>,
  outEdges: ReadonlyMap<string, ReadonlySet<string>>,
): ReadonlyMap<string, number> => {
  const counts = new Map<string, number>();
  for (const start of nodes) {
    const visited = new Set<string>();
    const queue: string[] = Array.from(outEdges.get(start) ?? []);
    while (queue.length > 0) {
      const curr = queue.pop()!;
      if (curr === start || visited.has(curr)) {
        continue;
      }
      visited.add(curr);
      for (const next of outEdges.get(curr) ?? []) {
        if (!visited.has(next)) {
          queue.push(next);
        }
      }
    }
    counts.set(start, visited.size);
  }
  return counts;
};

const computeLayers = (
  nodes: ReadonlyArray<string>,
  sccs: ReadonlyArray<ReadonlyArray<string>>,
  outEdges: ReadonlyMap<string, ReadonlySet<string>>,
): ReadonlyMap<string, number> => {
  const nodeToScc = new Map<string, number>();
  sccs.forEach((scc, idx) => {
    for (const n of scc) {
      nodeToScc.set(n, idx);
    }
  });

  const sccOut = new Map<number, Set<number>>();
  for (let i = 0; i < sccs.length; i += 1) {
    sccOut.set(i, new Set());
  }
  for (const n of nodes) {
    const fromScc = nodeToScc.get(n)!;
    for (const next of outEdges.get(n) ?? []) {
      const toScc = nodeToScc.get(next);
      if (toScc !== undefined && toScc !== fromScc) {
        sccOut.get(fromScc)!.add(toScc);
      }
    }
  }

  const sccDepth = new Map<number, number>();
  const getDepth = (sccIdx: number): number => {
    const cached = sccDepth.get(sccIdx);
    if (cached !== undefined) {
      return cached;
    }
    const children = sccOut.get(sccIdx) ?? new Set<number>();
    let maxChild = -1;
    for (const c of children) {
      maxChild = Math.max(maxChild, getDepth(c));
    }
    const d = maxChild + 1;
    sccDepth.set(sccIdx, d);
    return d;
  };

  const result = new Map<string, number>();
  for (const n of nodes) {
    result.set(n, getDepth(nodeToScc.get(n)!));
  }
  return result;
};

const jaccardSimilarity = (a: ReadonlySet<string>, b: ReadonlySet<string>): number => {
  if (a.size === 0 && b.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) {
      intersection += 1;
    }
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
};

const hasIntersection = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean => {
  if (a.length === 0 || b.length === 0) {
    return false;
  }
  const setB = new Set(b);
  return a.some((item) => setB.has(item));
};

const computeDirectoryCohesion = (
  modules: ReadonlyMap<string, ResolvedModuleData>,
  runtimeOutEdges: ReadonlyMap<string, ReadonlySet<string>>,
  runtimeInEdges: ReadonlyMap<string, ReadonlySet<string>>,
  minDirModules: number,
): ReadonlyArray<DirectoryCohesionMetric> => {
  const byDir = new Map<string, ResolvedModuleData[]>();
  for (const mod of modules.values()) {
    if (mod.isBarrel || mod.isTypeOnlyModule) {
      continue;
    }
    const list = byDir.get(mod.directory);
    if (list === undefined) {
      byDir.set(mod.directory, [mod]);
    } else {
      list.push(mod);
    }
  }

  const metrics: DirectoryCohesionMetric[] = [];

  for (const [directory, dirMods] of Array.from(byDir.entries()).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (dirMods.length < minDirModules) {
      continue;
    }

    const dirFileSet = new Set(dirMods.map((m) => m.filePath));
    let intraDirectoryEdges = 0;
    const adj = new Map<string, Set<string>>();
    for (const m of dirMods) {
      adj.set(m.filePath, new Set());
    }

    // Collect non-barrel callers for each module in the directory
    const callersByMod = new Map<string, Set<string>>();
    for (const m of dirMods) {
      const callers = new Set<string>();
      for (const c of runtimeInEdges.get(m.filePath) ?? []) {
        const callerMod = modules.get(c);
        if (callerMod !== undefined && !callerMod.isBarrel) {
          callers.add(c);
        }
      }
      callersByMod.set(m.filePath, callers);
    }

    // Pairwise cohesion edges
    let jaccardSum = 0;
    let jaccardPairs = 0;

    for (let i = 0; i < dirMods.length; i += 1) {
      const m1 = dirMods[i]!;
      for (const target of runtimeOutEdges.get(m1.filePath) ?? []) {
        if (dirFileSet.has(target) && target !== m1.filePath) {
          intraDirectoryEdges += 1;
        }
      }

      for (let j = i + 1; j < dirMods.length; j += 1) {
        const m2 = dirMods[j]!;
        const c1 = callersByMod.get(m1.filePath)!;
        const c2 = callersByMod.get(m2.filePath)!;
        const jaccard = jaccardSimilarity(c1, c2);
        if (c1.size > 0 || c2.size > 0) {
          jaccardSum += jaccard;
          jaccardPairs += 1;
        }

        const intraEdge =
          (runtimeOutEdges.get(m1.filePath)?.has(m2.filePath) ?? false) ||
          (runtimeOutEdges.get(m2.filePath)?.has(m1.filePath) ?? false);
        const sharedDomainType = hasIntersection(
          m1.referencedDomainTypes,
          m2.referencedDomainTypes,
        );
        const sharedExternalDep = hasIntersection(
          m1.domainExternalDependencies,
          m2.domainExternalDependencies,
        );
        const sharedCallers = jaccard >= 0.25;

        if (intraEdge || sharedDomainType || sharedExternalDep || sharedCallers) {
          adj.get(m1.filePath)!.add(m2.filePath);
          adj.get(m2.filePath)!.add(m1.filePath);
        }
      }
    }

    // Connected components via BFS
    const visited = new Set<string>();
    const clusters: DirectoryCluster[] = [];

    for (const m of dirMods) {
      if (visited.has(m.filePath)) {
        continue;
      }
      const comp: ResolvedModuleData[] = [];
      const queue = [m.filePath];
      visited.add(m.filePath);
      while (queue.length > 0) {
        const curr = queue.shift()!;
        comp.push(modules.get(curr)!);
        for (const next of adj.get(curr) ?? []) {
          if (!visited.has(next)) {
            visited.add(next);
            queue.push(next);
          }
        }
      }

      const depSet = new Set<string>();
      const callerSet = new Set<string>();
      for (const cm of comp) {
        for (const d of cm.domainExternalDependencies) {
          depSet.add(d);
        }
        for (const c of callersByMod.get(cm.filePath) ?? []) {
          const callerMod = modules.get(c);
          if (callerMod !== undefined) {
            callerSet.add(callerMod.relativePath);
          }
        }
      }

      clusters.push({
        modules: comp.map((cm) => cm.relativePath).sort(),
        sharedDependencies: Array.from(depSet).sort(),
        callers: Array.from(callerSet).sort(),
      });
    }

    clusters.sort((a, b) => b.modules.length - a.modules.length || a.modules[0]!.localeCompare(b.modules[0]!));

    const distinctExtSet = new Set<string>();
    for (const m of dirMods) {
      for (const d of m.domainExternalDependencies) {
        distinctExtSet.add(d);
      }
    }

    const cohesionScore =
      dirMods.length <= 1
        ? 1
        : Number((1 - (clusters.length - 1) / (dirMods.length - 1)).toFixed(3));
    const averageCallerJaccard =
      jaccardPairs === 0 ? 0 : Number((jaccardSum / jaccardPairs).toFixed(3));

    metrics.push({
      directory,
      moduleCount: dirMods.length,
      clusterCount: clusters.length,
      cohesionScore,
      averageCallerJaccard,
      intraDirectoryEdges,
      distinctExternalDeps: Array.from(distinctExtSet).sort(),
      clusters,
    });
  }

  return metrics;
};

export const buildProjectDag = (input: BuildProjectDagInput): BuiltProjectDag => {
  const {
    program,
    checker,
    inspector,
    targetFiles,
    projectBaseDir,
    excludePatterns,
    minDirModules,
    preExtractedIRs,
  } = input;

  const targetSet = new Set(targetFiles.map((f) => path.resolve(f)));

  // Collect all in-scope source files from ts.Program
  const selectedSourceFiles: ts.SourceFile[] = [];
  for (const sf of program.getSourceFiles()) {
    const abs = path.resolve(sf.fileName);
    if (sf.isDeclarationFile || abs.includes(`${path.sep}node_modules${path.sep}`) || !isTsSourceFile(abs)) {
      continue;
    }
    const isTarget = targetSet.has(abs);
    if (!isTarget) {
      const relToBase = path.relative(projectBaseDir, abs);
      if (isDefaultTestOrFixtureFile(relToBase) || matchesExcludePatterns(abs, excludePatterns)) {
        continue;
      }
    }
    selectedSourceFiles.push(sf);
  }

  selectedSourceFiles.sort((a, b) => a.fileName.localeCompare(b.fileName));
  const inScopeFileSet = new Set(selectedSourceFiles.map((sf) => path.resolve(sf.fileName)));
  const rootDir = computeCommonRootDir(Array.from(inScopeFileSet));
  const resolutionCache = ts.createModuleResolutionCache(
    projectBaseDir,
    (f) => f,
    program.getCompilerOptions(),
  );

  const modules = new Map<string, ResolvedModuleData>();

  for (const sf of selectedSourceFiles) {
    const abs = path.resolve(sf.fileName);
    const ir =
      preExtractedIRs?.get(abs) ?? extractModuleIR({ sourceFile: sf, checker, inspector });
    const { isBarrel, isTypeOnlyModule } = detectBarrelAndTypeOnly(sf, ir);
    const primaryExport = findPrimaryExportedBinding(ir);
    const refs = resolveModuleReferences(sf, program, inScopeFileSet, resolutionCache);

    const domainTypeSet = new Set<string>();
    const visitedTypes = new Set<ts.Type>();
    let exportedEffects: ReadonlyArray<string> = [];
    let primitiveInputKind: O.Option<'string' | 'number' | 'boolean'> = O.none;

    if (O.isSome(primaryExport)) {
      const exportType = checker.getTypeAtLocation(primaryExport.value.declaration);
      collectDomainTypeNamesFromType(checker, exportType, domainTypeSet, visitedTypes, 0);
      exportedEffects = detectDeepEffects(inspector, exportType);
      primitiveInputKind = extractPrimitiveInputKind(checker, exportType);
    }
    for (const td of ir.typeDeclarations) {
      const tdType = checker.getTypeAtLocation(td.node);
      if (
        tdType.getCallSignatures().length === 0 &&
        !BUILTIN_AND_CONTAINER_TYPE_NAMES.has(td.name)
      ) {
        domainTypeSet.add(td.name);
      }
    }

    modules.set(abs, {
      filePath: abs,
      relativePath: toRelativePosixPath(rootDir, abs),
      directory: toRelativeDirectory(rootDir, abs),
      sourceFile: sf,
      ir,
      isTarget: targetSet.has(abs),
      isBarrel,
      isTypeOnlyModule,
      exportedFunction: O.map((b: BindingInfo) => b.name)(primaryExport),
      exportedSignature: O.map((b: BindingInfo) => b.signature)(primaryExport),
      exportedEffects,
      primitiveInputKind,
      internalImports: refs.internalImports,
      externalDependencies: refs.externalDependencies,
      domainExternalDependencies: refs.domainExternalDependencies,
      referencedDomainTypes: Array.from(domainTypeSet).sort(),
    });
  }

  const allFiles = Array.from(modules.keys()).sort();
  const runtimeOutEdges = new Map<string, Set<string>>();
  const runtimeInEdges = new Map<string, Set<string>>();
  const allOutEdges = new Map<string, Set<string>>();
  const allInEdges = new Map<string, Set<string>>();

  for (const f of allFiles) {
    runtimeOutEdges.set(f, new Set());
    runtimeInEdges.set(f, new Set());
    allOutEdges.set(f, new Set());
    allInEdges.set(f, new Set());
  }

  const edges: ProjectEdge[] = [];
  for (const mod of modules.values()) {
    for (const imp of mod.internalImports) {
      allOutEdges.get(mod.filePath)!.add(imp.targetFile);
      allInEdges.get(imp.targetFile)!.add(mod.filePath);
      if (!imp.isTypeOnly) {
        runtimeOutEdges.get(mod.filePath)!.add(imp.targetFile);
        runtimeInEdges.get(imp.targetFile)!.add(mod.filePath);
      }
      edges.push({
        from: mod.relativePath,
        to: modules.get(imp.targetFile)!.relativePath,
        isTypeOnly: imp.isTypeOnly,
        importedSymbols: imp.importedSymbols,
      });
    }
  }

  const sccs = computeTarjanSccs(allFiles, allOutEdges);
  const cycles: ReadonlyArray<ReadonlyArray<string>> = sccs
    .filter((scc) => scc.length >= 2)
    .map((scc) => [...scc].sort());

  const transitiveCounts = computeTransitiveCounts(allFiles, runtimeOutEdges);
  const layers = computeLayers(allFiles, sccs, runtimeOutEdges);
  const directories = computeDirectoryCohesion(
    modules,
    runtimeOutEdges,
    runtimeInEdges,
    minDirModules,
  );

  const nodes: ProjectModuleNode[] = [];
  const nodeByFile = new Map<string, ProjectModuleNode>();
  let maxDepth = 0;
  let barrelCount = 0;

  for (const f of allFiles) {
    const mod = modules.get(f)!;
    const inDegree = allInEdges.get(f)!.size;
    const outDegree = allOutEdges.get(f)!.size;
    const layer = layers.get(f) ?? 0;
    maxDepth = Math.max(maxDepth, layer);
    if (mod.isBarrel) {
      barrelCount += 1;
    }

    const node: ProjectModuleNode = {
      filePath: mod.filePath,
      relativePath: mod.relativePath,
      directory: mod.directory,
      isTarget: mod.isTarget,
      isBarrel: mod.isBarrel,
      isTypeOnlyModule: mod.isTypeOnlyModule,
      isEntrypoint: inDegree === 0 && !mod.isTypeOnlyModule,
      exportedFunction: mod.exportedFunction,
      exportedSignature: mod.exportedSignature,
      effects: mod.exportedEffects,
      inDegree,
      outDegree,
      transitiveDependencyCount: transitiveCounts.get(f) ?? 0,
      externalDependencies: mod.externalDependencies,
      domainExternalDependencies: mod.domainExternalDependencies,
      referencedDomainTypes: mod.referencedDomainTypes,
      layer,
    };
    nodes.push(node);
    nodeByFile.set(f, node);
  }

  const summary: ProjectDagSummary = {
    analyzedModuleCount: nodes.length,
    targetFileCount: targetFiles.length,
    edgeCount: edges.length,
    cycleCount: cycles.length,
    directoryCount: new Set(nodes.map((n) => n.directory)).size,
    maxDepth,
    barrelCount,
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
};
