import * as E from 'fp-ts/lib/Either.js';
import * as O from 'fp-ts/lib/Option.js';
import * as path from 'node:path';
import * as ts from 'typescript';
import { loadTargetProgram, type LoadedProgram } from './compiler/programLoader.js';
import { createTypeInspector } from './compiler/typeUtils.js';
import { runAllCrossFileHints } from './crossFile/index.js';
import { expandTargetPaths } from './graph/fileDiscovery.js';
import { buildProjectDag } from './graph/projectDag.js';
import { runAllHints } from './hints/index.js';
import { extractModuleIR } from './ir/moduleGraph.js';
import type {
  CrossFileHint,
  CrossFileHintCategory,
  DirectoryCluster,
  DirectoryCohesionMetric,
  ProjectAnalysisReport,
  ProjectAnalysisSummary,
  ProjectDagGraph,
  ProjectDagSummary,
  ProjectEdge,
  ProjectModuleNode,
  ResolvedAnalyzeOptions,
} from './model/projectReport.js';
import {
  buildAnalysisReport,
  type AnalysisReport,
  type AnalyzeOptions,
  type RuleContext,
  type TypeInspector,
} from './model/report.js';
import { runAllRules } from './rules/index.js';

export type {
  AgentHint,
  AnalysisReport,
  AnalysisSummary,
  AnalyzeOptions,
  BindingInfo,
  DiagnosticError,
  ErrorCategory,
  FieldInfo,
  HintCategory,
  HintPriority,
  ImportInfo,
  ModuleIR,
  NodeKind,
  OutputFormat,
  RuleContext,
  SourceLocation,
  TypeDeclInfo,
  TypeFlowEdge,
  TypeFlowGraph,
  TypeFlowNode,
} from './model/report.js';

export type {
  CrossFileHint,
  CrossFileHintCategory,
  DirectoryCluster,
  DirectoryCohesionMetric,
  ProjectAnalysisReport,
  ProjectAnalysisSummary,
  ProjectDagGraph,
  ProjectDagSummary,
  ProjectEdge,
  ProjectModuleNode,
  ResolvedAnalyzeOptions,
} from './model/projectReport.js';

export type AnalyzeRequest = {
  readonly filePaths: ReadonlyArray<string>;
  readonly options: AnalyzeOptions;
};

export type AnalyzeFiles = (
  request: AnalyzeRequest,
) => E.Either<string, ProjectAnalysisReport>;

export const resolveAnalyzeOptions = (options: AnalyzeOptions): ResolvedAnalyzeOptions => ({
  tsconfigPath: options.tsconfigPath,
  maxFlowSteps: options.maxFlowSteps,
  format: options.format,
  includeGraph: options.includeGraph ?? false,
  minPatternOccurrences: options.minPatternOccurrences ?? 3,
  minDirModules: options.minDirModules ?? 3,
  excludePatterns: options.excludePatterns ?? [],
});

const analyzeSourceFile = (
  loaded: LoadedProgram,
  inspector: TypeInspector,
  options: ResolvedAnalyzeOptions,
  sf: ts.SourceFile,
): { readonly report: AnalysisReport; readonly ir: ReturnType<typeof extractModuleIR> } => {
  const ir = extractModuleIR({
    sourceFile: sf,
    checker: loaded.checker,
    inspector,
  });
  const ctx: RuleContext = {
    sourceFile: sf,
    checker: loaded.checker,
    inspector,
    ir,
    options,
    tscErrors: loaded.getTscErrors(sf),
  };
  return {
    report: buildAnalysisReport({
      filePath: sf.fileName,
      errors: runAllRules(ctx),
      hints: runAllHints(ctx),
      ir,
    }),
    ir,
  };
};

const analyzeWithLoadedProgram = (
  expandedTargets: ReadonlyArray<string>,
  options: ResolvedAnalyzeOptions,
  loaded: LoadedProgram,
): E.Either<string, ProjectAnalysisReport> => {
  const inspector = createTypeInspector(loaded.checker);
  const fileReports: AnalysisReport[] = [];
  const preExtractedIRs = new Map<string, ReturnType<typeof extractModuleIR>>();

  for (const fp of expandedTargets) {
    const abs = path.resolve(fp);
    const sf = loaded.program.getSourceFile(abs);
    if (sf === undefined) {
      return E.left(`Could not load TypeScript source file: ${fp}`);
    }
    const { report, ir } = analyzeSourceFile(loaded, inspector, options, sf);
    fileReports.push(report);
    preExtractedIRs.set(abs, ir);
  }

  const dag = buildProjectDag({
    program: loaded.program,
    checker: loaded.checker,
    inspector,
    targetFiles: expandedTargets,
    projectBaseDir: loaded.projectBaseDir,
    excludePatterns: options.excludePatterns,
    minDirModules: options.minDirModules,
    preExtractedIRs,
  });

  const crossFileHints = runAllCrossFileHints(dag, loaded.checker, inspector, options);

  const passedFiles = fileReports.filter((r) => r.passed).length;
  const failedFiles = fileReports.length - passedFiles;
  const totalErrors = fileReports.reduce((acc, r) => acc + r.summary.errorCount, 0);
  const totalFileHints = fileReports.reduce((acc, r) => acc + r.summary.hintCount, 0);

  const summary: ProjectAnalysisSummary = {
    totalFiles: fileReports.length,
    passedFiles,
    failedFiles,
    totalErrors,
    totalFileHints,
    totalCrossFileHints: crossFileHints.length,
  };

  const projectGraph: ProjectDagGraph = {
    rootDir: dag.rootDir,
    nodes: dag.nodes,
    edges: dag.edges,
    cycles: dag.cycles.map((scc) => scc.map((f) => dag.modules.get(f)?.relativePath ?? f)),
    directories: dag.directories,
  };

  return E.right({
    passed: failedFiles === 0,
    summary,
    files: fileReports,
    projectGraphSummary: dag.summary,
    ...(options.includeGraph ? { projectGraph } : {}),
    crossFileHints,
  });
};

export const analyzeFiles: AnalyzeFiles = (request) => {
  const resolvedOptions = resolveAnalyzeOptions(request.options);
  const expandedTargets = expandTargetPaths(request.filePaths, resolvedOptions.excludePatterns);

  if (expandedTargets.length === 0) {
    return E.left('No target TypeScript files found after expanding paths and exclusions.');
  }

  const loadedEither = loadTargetProgram({
    filePaths: expandedTargets,
    tsconfigPath: resolvedOptions.tsconfigPath,
  });

  if (E.isLeft(loadedEither)) {
    return loadedEither;
  }

  return analyzeWithLoadedProgram(expandedTargets, resolvedOptions, loadedEither.right);
};
