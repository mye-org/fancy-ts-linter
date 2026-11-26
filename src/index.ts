import * as B from 'fp-ts/lib/boolean.js';
import * as E from 'fp-ts/lib/Either.js';
import * as M from 'fp-ts/lib/Monoid.js';
import * as N from 'fp-ts/lib/number.js';
import * as O from 'fp-ts/lib/Option.js';
import * as RA from 'fp-ts/lib/ReadonlyArray.js';
import * as RM from 'fp-ts/lib/ReadonlyMap.js';
import * as S from 'fp-ts/lib/string.js';
import { constant, flow } from 'fp-ts/lib/function.js';
import * as path from 'node:path';
import * as ts from 'typescript';
import { loadTargetProgram, type LoadedProgram } from './compiler/programLoader.js';
import { createTypeInspector } from './compiler/typeUtils.js';
import { runAllCrossFileHints } from './crossFile/index.js';
import { expandTargetPaths } from './graph/fileDiscovery.js';
import { buildProjectDag } from './graph/projectDag.js';
import { runAllHints } from './hints/index.js';
import { extractModuleIR } from './ir/moduleGraph.js';
import {
  buildProjectAnalysisReport,
  type BuiltProjectDag,
  type CrossFileHint,
  type CrossFileHintCategory,
  type DirectoryCluster,
  type DirectoryCohesionMetric,
  type FileCount,
  type ModuleCount,
  type OccurrenceCount,
  type ProjectAnalysisReport,
  type ProjectAnalysisSummary,
  type ProjectDagGraph,
  type ProjectDagSummary,
  type ProjectEdge,
  type ProjectModuleNode,
  type RelativePath,
  type ResolvedAnalyzeOptions,
  type ResolvedModuleData,
  type StepCount,
} from './model/projectReport.js';
import { iso } from 'newtype-ts';
import {
  buildAnalysisReport,
  type AnalysisReport,
  type AnalyzeOptions,
  type ErrorCount,
  type HintCount,
  type ModuleIR,
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

type AnalyzeSourceFileInput = {
  readonly loaded: LoadedProgram;
  readonly inspector: TypeInspector;
  readonly options: ResolvedAnalyzeOptions;
  readonly sf: ts.SourceFile;
};

type AnalyzedSourceEntry = {
  readonly abs: string;
  readonly report: AnalysisReport;
  readonly ir: ModuleIR;
};

type AnalyzeWithLoadedProgramInput = {
  readonly expandedTargets: ReadonlyArray<string>;
  readonly options: ResolvedAnalyzeOptions;
  readonly loaded: LoadedProgram;
};

const constFalse = constant(false);
const defaultThree = constant(3);
const emptyStrings = constant(RA.zero<string>());

const isoStepCount = iso<StepCount>();
const isoOccurrenceCount = iso<OccurrenceCount>();
const isoModuleCount = iso<ModuleCount>();
const isoFileCount = iso<FileCount>();
const isoRelativePath = iso<RelativePath>();

const resolveAnalyzeOptions = (options: AnalyzeOptions) => ({
  tsconfigPath: options.tsconfigPath,
  maxFlowSteps: isoStepCount.wrap(options.maxFlowSteps),
  format: options.format,
  includeGraph: O.getOrElse(constFalse)(options.includeGraph),
  minPatternOccurrences: isoOccurrenceCount.wrap(
    O.getOrElse(defaultThree)(options.minPatternOccurrences),
  ),
  minDirModules: isoModuleCount.wrap(O.getOrElse(defaultThree)(options.minDirModules)),
  excludePatterns: O.getOrElse(emptyStrings)(options.excludePatterns),
});

const toAnalyzeOptions = (options: ResolvedAnalyzeOptions) => ({
  tsconfigPath: options.tsconfigPath,
  maxFlowSteps: isoStepCount.unwrap(options.maxFlowSteps),
  format: options.format,
  includeGraph: O.some(options.includeGraph),
  minPatternOccurrences: O.some(isoOccurrenceCount.unwrap(options.minPatternOccurrences)),
  minDirModules: O.some(isoModuleCount.unwrap(options.minDirModules)),
  excludePatterns: O.some(options.excludePatterns),
});

const analyzeSourceFile = ({
  loaded,
  inspector,
  options,
  sf,
}: AnalyzeSourceFileInput) => {
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
    options: toAnalyzeOptions(options),
    tscErrors: loaded.getTscErrors(sf),
  };
  return {
    abs: path.resolve(sf.fileName),
    report: buildAnalysisReport({
      filePath: sf.fileName,
      errors: runAllRules(ctx),
      hints: runAllHints(ctx),
      ir,
    }),
    ir,
  };
};

const resolveSourceFile =
  (loaded: LoadedProgram) =>
  (fp: string): E.Either<string, ts.SourceFile> =>
    O.match(
      () => E.left(`Could not load TypeScript source file: ${fp}`),
      E.right<string, ts.SourceFile>,
    )(O.fromNullable(loaded.program.getSourceFile(path.resolve(fp))));

const isoErrorCount = iso<ErrorCount>();
const isoHintCount = iso<HintCount>();

const getEntryReport = (entry: AnalyzedSourceEntry) => entry.report;
const toIrMapEntry = (entry: AnalyzedSourceEntry) =>
  [entry.abs, entry.ir] as const;
const isReportPassed = (r: AnalysisReport) => r.passed;
const getReportErrorCount = (r: AnalysisReport) => isoErrorCount.unwrap(r.summary.errorCount);
const getReportHintCount = (r: AnalysisReport) => isoHintCount.unwrap(r.summary.hintCount);
const getRelativePath = (m: ResolvedModuleData) => isoRelativePath.unwrap(m.relativePath);

const resolveCyclePath =
  (modules: ReadonlyMap<string, ResolvedModuleData>) => (filePath: string) =>
    O.match(() => filePath, getRelativePath)(RM.lookup(S.Eq)(filePath)(modules));

const mapCycle = (modules: ReadonlyMap<string, ResolvedModuleData>) =>
  RA.map(resolveCyclePath(modules));

const buildGraphFromDag = (dag: BuiltProjectDag) => ({
  rootDir: dag.rootDir,
  nodes: dag.nodes,
  edges: dag.edges,
  cycles: RA.map(mapCycle(dag.modules))(dag.cycles),
  directories: dag.directories,
});

const buildReportFromEntries =
  ({ expandedTargets, options, loaded }: AnalyzeWithLoadedProgramInput) =>
  (entries: ReadonlyArray<AnalyzedSourceEntry>) => {
    const inspector = createTypeInspector(loaded.checker);
    const fileReports = RA.map(getEntryReport)(entries);
    const preExtractedIRs: ReadonlyMap<string, ModuleIR> = new Map(RA.map(toIrMapEntry)(entries));
    const dag = buildProjectDag({
      program: loaded.program,
      checker: loaded.checker,
      inspector,
      targetFiles: expandedTargets,
      projectBaseDir: loaded.projectBaseDir,
      excludePatterns: options.excludePatterns,
      minDirModules: isoModuleCount.unwrap(options.minDirModules),
      preExtractedIRs,
    });
    const crossFileHints = runAllCrossFileHints({
      dag,
      checker: loaded.checker,
      inspector,
      options,
    });
    const passedFiles = RA.filter(isReportPassed)(fileReports).length;
    const failedFiles = fileReports.length - passedFiles;
    const totalErrors = M.concatAll(N.MonoidSum)(RA.map(getReportErrorCount)(fileReports));
    const totalFileHints = M.concatAll(N.MonoidSum)(RA.map(getReportHintCount)(fileReports));
    const summary: ProjectAnalysisSummary = {
      totalFiles: isoFileCount.wrap(fileReports.length),
      passedFiles: isoFileCount.wrap(passedFiles),
      failedFiles: isoFileCount.wrap(failedFiles),
      totalErrors: isoErrorCount.wrap(totalErrors),
      totalFileHints: isoHintCount.wrap(totalFileHints),
      totalCrossFileHints: isoHintCount.wrap(crossFileHints.length),
    };
    const projectGraph = B.match(
      () => O.none,
      () => O.some(buildGraphFromDag(dag)),
    )(options.includeGraph);
    return buildProjectAnalysisReport({
      passed: failedFiles === 0,
      summary,
      files: fileReports,
      projectGraphSummary: dag.summary,
      projectGraph,
      crossFileHints,
    });
  };

const analyzeWithLoadedProgram = ({
  expandedTargets,
  options,
  loaded,
}: AnalyzeWithLoadedProgramInput): E.Either<string, ProjectAnalysisReport> => {
  const inspector = createTypeInspector(loaded.checker);
  const analyzeSf = (sf: ts.SourceFile) => analyzeSourceFile({ loaded, inspector, options, sf });
  return flow(
    RA.traverse(E.Applicative)(resolveSourceFile(loaded)),
    E.map(RA.map(analyzeSf)),
    E.map(buildReportFromEntries({ expandedTargets, options, loaded })),
  )(expandedTargets);
};

const hasNonEmptyTargets = (targets: ReadonlyArray<string>) => targets.length > 0;
const noTargetsError = constant(
  'No target TypeScript files found after expanding paths and exclusions.',
);

type RunWithLoadedInput = {
  readonly expandedTargets: ReadonlyArray<string>;
  readonly options: ResolvedAnalyzeOptions;
};

const runWithLoaded =
  ({ expandedTargets, options }: RunWithLoadedInput) =>
  (loaded: LoadedProgram) =>
    analyzeWithLoadedProgram({ expandedTargets, options, loaded });

const analyzeNonEmptyTargets =
  (options: ResolvedAnalyzeOptions) => (expandedTargets: ReadonlyArray<string>) =>
    E.chain(runWithLoaded({ expandedTargets, options }))(
      loadTargetProgram({
        filePaths: expandedTargets,
        tsconfigPath: options.tsconfigPath,
      }),
    );

export const analyzeFiles = ((request) => {
  const resolvedOptions = resolveAnalyzeOptions(request.options);
  const expandedTargets = expandTargetPaths({
    inputPaths: request.filePaths,
    excludePatterns: resolvedOptions.excludePatterns,
  });
  return E.chain(analyzeNonEmptyTargets(resolvedOptions))(
    E.fromPredicate(hasNonEmptyTargets, noTargetsError)(expandedTargets),
  );
}) satisfies AnalyzeFiles;
