import type * as O from 'fp-ts/lib/Option.js';
import type * as ts from 'typescript';
import type { AnalysisReport, HintPriority, ModuleIR } from './report.js';

export type CrossFileHintCategory =
  | 'junk-drawer-directory'
  | 'misplaced-scope'
  | 'dependency-cycle'
  | 'hub-bottleneck'
  | 'missing-domain-model'
  | 'pipeline-motif'
  | 'generic-abstraction'
  | 'environment-threading'
  | 'architectural-motif';

export type CrossFileHint = {
  readonly hintId: string;
  readonly category: CrossFileHintCategory;
  readonly priority: HintPriority;
  readonly files: ReadonlyArray<string>;
  readonly symbols: ReadonlyArray<string>;
  readonly evidence: string;
  readonly suggestion: string;
  readonly suggestedSignature: O.Option<string>;
  readonly researchQuestions: ReadonlyArray<string>;
};

export type ProjectModuleNode = {
  readonly filePath: string;
  readonly relativePath: string;
  readonly directory: string;
  readonly isTarget: boolean;
  readonly isBarrel: boolean;
  readonly isTypeOnlyModule: boolean;
  readonly isEntrypoint: boolean;
  readonly exportedFunction: O.Option<string>;
  readonly exportedSignature: O.Option<string>;
  readonly effects: ReadonlyArray<string>;
  readonly inDegree: number;
  readonly outDegree: number;
  readonly transitiveDependencyCount: number;
  readonly externalDependencies: ReadonlyArray<string>;
  readonly domainExternalDependencies: ReadonlyArray<string>;
  readonly referencedDomainTypes: ReadonlyArray<string>;
  readonly layer: number;
};

export type ProjectEdge = {
  readonly from: string;
  readonly to: string;
  readonly isTypeOnly: boolean;
  readonly importedSymbols: ReadonlyArray<string>;
};

export type DirectoryCluster = {
  readonly modules: ReadonlyArray<string>;
  readonly sharedDependencies: ReadonlyArray<string>;
  readonly callers: ReadonlyArray<string>;
};

export type DirectoryCohesionMetric = {
  readonly directory: string;
  readonly moduleCount: number;
  readonly clusterCount: number;
  readonly cohesionScore: number;
  readonly averageCallerJaccard: number;
  readonly intraDirectoryEdges: number;
  readonly distinctExternalDeps: ReadonlyArray<string>;
  readonly clusters: ReadonlyArray<DirectoryCluster>;
};

export type ProjectDagSummary = {
  readonly analyzedModuleCount: number;
  readonly targetFileCount: number;
  readonly edgeCount: number;
  readonly cycleCount: number;
  readonly directoryCount: number;
  readonly maxDepth: number;
  readonly barrelCount: number;
};

export type ProjectDagGraph = {
  readonly rootDir: string;
  readonly nodes: ReadonlyArray<ProjectModuleNode>;
  readonly edges: ReadonlyArray<ProjectEdge>;
  readonly cycles: ReadonlyArray<ReadonlyArray<string>>;
  readonly directories: ReadonlyArray<DirectoryCohesionMetric>;
};

export type ProjectAnalysisSummary = {
  readonly totalFiles: number;
  readonly passedFiles: number;
  readonly failedFiles: number;
  readonly totalErrors: number;
  readonly totalFileHints: number;
  readonly totalCrossFileHints: number;
};

export type ProjectAnalysisReport = {
  readonly passed: boolean;
  readonly summary: ProjectAnalysisSummary;
  readonly files: ReadonlyArray<AnalysisReport>;
  readonly projectGraphSummary: ProjectDagSummary;
  readonly projectGraph: O.Option<ProjectDagGraph>;
  readonly crossFileHints: ReadonlyArray<CrossFileHint>;
};

export type ResolvedModuleData = {
  readonly filePath: string;
  readonly relativePath: string;
  readonly directory: string;
  readonly sourceFile: ts.SourceFile;
  readonly ir: ModuleIR;
  readonly isTarget: boolean;
  readonly isBarrel: boolean;
  readonly isTypeOnlyModule: boolean;
  readonly exportedFunction: O.Option<string>;
  readonly exportedSignature: O.Option<string>;
  readonly exportedEffects: ReadonlyArray<string>;
  readonly primitiveInputKind: O.Option<'string' | 'number' | 'boolean'>;
  readonly internalImports: ReadonlyArray<{
    readonly targetFile: string;
    readonly isTypeOnly: boolean;
    readonly importedSymbols: ReadonlyArray<string>;
  }>;
  readonly externalDependencies: ReadonlyArray<string>;
  readonly domainExternalDependencies: ReadonlyArray<string>;
  readonly referencedDomainTypes: ReadonlyArray<string>;
};

export type BuiltProjectDag = {
  readonly rootDir: string;
  readonly modules: ReadonlyMap<string, ResolvedModuleData>;
  readonly nodes: ReadonlyArray<ProjectModuleNode>;
  readonly nodeByFile: ReadonlyMap<string, ProjectModuleNode>;
  readonly edges: ReadonlyArray<ProjectEdge>;
  readonly runtimeOutEdges: ReadonlyMap<string, ReadonlySet<string>>;
  readonly runtimeInEdges: ReadonlyMap<string, ReadonlySet<string>>;
  readonly allOutEdges: ReadonlyMap<string, ReadonlySet<string>>;
  readonly allInEdges: ReadonlyMap<string, ReadonlySet<string>>;
  readonly cycles: ReadonlyArray<ReadonlyArray<string>>;
  readonly directories: ReadonlyArray<DirectoryCohesionMetric>;
  readonly summary: ProjectDagSummary;
};

export type ResolvedAnalyzeOptions = {
  readonly tsconfigPath: O.Option<string>;
  readonly maxFlowSteps: number;
  readonly format: 'json' | 'md';
  readonly includeGraph: boolean;
  readonly minPatternOccurrences: number;
  readonly minDirModules: number;
  readonly excludePatterns: ReadonlyArray<string>;
};

export type BuildProjectAnalysisReportInput = {
  readonly passed: boolean;
  readonly summary: ProjectAnalysisSummary;
  readonly files: ReadonlyArray<AnalysisReport>;
  readonly projectGraphSummary: ProjectDagSummary;
  readonly projectGraph: O.Option<ProjectDagGraph>;
  readonly crossFileHints: ReadonlyArray<CrossFileHint>;
};

export type BuildProjectAnalysisReport = (
  input: BuildProjectAnalysisReportInput,
) => ProjectAnalysisReport;

export const buildProjectAnalysisReport = ((input: BuildProjectAnalysisReportInput) => ({
  passed: input.passed,
  summary: input.summary,
  files: input.files,
  projectGraphSummary: input.projectGraphSummary,
  projectGraph: input.projectGraph,
  crossFileHints: input.crossFileHints,
})) satisfies BuildProjectAnalysisReport;
