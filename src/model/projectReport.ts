import type * as O from 'fp-ts/lib/Option.js';
import { Newtype } from 'newtype-ts';
import type * as ts from 'typescript';
import type { FilePath } from '../graph/toRelativePosixPath.js';
import type {
  AnalysisReport,
  ErrorCount,
  HintCount,
  HintId,
  HintPriority,
  ModuleIR,
} from './report.js';

export type RelativePath = Newtype<{ readonly RelativePath: unique symbol }, string>;
export type DirectoryPath = Newtype<{ readonly DirectoryPath: unique symbol }, string>;
export type ModuleCount = Newtype<{ readonly ModuleCount: unique symbol }, number>;
export type ClusterCount = Newtype<{ readonly ClusterCount: unique symbol }, number>;
export type CohesionScore = Newtype<{ readonly CohesionScore: unique symbol }, number>;
export type JaccardScore = Newtype<{ readonly JaccardScore: unique symbol }, number>;
export type EdgeCount = Newtype<{ readonly EdgeCount: unique symbol }, number>;
export type CycleCount = Newtype<{ readonly CycleCount: unique symbol }, number>;
export type DirectoryCount = Newtype<{ readonly DirectoryCount: unique symbol }, number>;
export type DepthCount = Newtype<{ readonly DepthCount: unique symbol }, number>;
export type DependencyCount = Newtype<{ readonly DependencyCount: unique symbol }, number>;
export type LayerIndex = Newtype<{ readonly LayerIndex: unique symbol }, number>;
export type FileCount = Newtype<{ readonly FileCount: unique symbol }, number>;
export type StepCount = Newtype<{ readonly StepCount: unique symbol }, number>;
export type OccurrenceCount = Newtype<{ readonly OccurrenceCount: unique symbol }, number>;

export type ModuleScope = 'target' | 'dependency';
export type ModuleKind = 'standard' | 'barrel' | 'type-only' | 'barrel-type-only';
export type ModuleRole = 'entrypoint' | 'internal';

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
  readonly hintId: HintId;
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
  readonly filePath: FilePath;
  readonly relativePath: RelativePath;
  readonly directory: DirectoryPath;
  readonly scope: ModuleScope;
  readonly moduleKind: ModuleKind;
  readonly role: ModuleRole;
  readonly exportedFunction: O.Option<string>;
  readonly exportedSignature: O.Option<string>;
  readonly effects: ReadonlyArray<string>;
  readonly inDegree: ModuleCount;
  readonly outDegree: ModuleCount;
  readonly transitiveDependencyCount: DependencyCount;
  readonly externalDependencies: ReadonlyArray<string>;
  readonly domainExternalDependencies: ReadonlyArray<string>;
  readonly referencedDomainTypes: ReadonlyArray<string>;
  readonly layer: LayerIndex;
};

export type ProjectEdge = {
  readonly from: FilePath;
  readonly to: FilePath;
  readonly isTypeOnly: boolean;
  readonly importedSymbols: ReadonlyArray<string>;
};

export type DirectoryCluster = {
  readonly modules: ReadonlyArray<string>;
  readonly sharedDependencies: ReadonlyArray<string>;
  readonly callers: ReadonlyArray<string>;
};

export type DirectoryCohesionMetric = {
  readonly directory: DirectoryPath;
  readonly moduleCount: ModuleCount;
  readonly clusterCount: ClusterCount;
  readonly cohesionScore: CohesionScore;
  readonly averageCallerJaccard: JaccardScore;
  readonly intraDirectoryEdges: EdgeCount;
  readonly distinctExternalDeps: ReadonlyArray<string>;
  readonly clusters: ReadonlyArray<DirectoryCluster>;
};

export type ProjectDagSummary = {
  readonly analyzedModuleCount: ModuleCount;
  readonly targetFileCount: ModuleCount;
  readonly edgeCount: EdgeCount;
  readonly cycleCount: CycleCount;
  readonly directoryCount: DirectoryCount;
  readonly maxDepth: DepthCount;
  readonly barrelCount: ModuleCount;
};

export type ProjectDagGraph = {
  readonly rootDir: string;
  readonly nodes: ReadonlyArray<ProjectModuleNode>;
  readonly edges: ReadonlyArray<ProjectEdge>;
  readonly cycles: ReadonlyArray<ReadonlyArray<string>>;
  readonly directories: ReadonlyArray<DirectoryCohesionMetric>;
};

export type ProjectAnalysisSummary = {
  readonly totalFiles: FileCount;
  readonly passedFiles: FileCount;
  readonly failedFiles: FileCount;
  readonly totalErrors: ErrorCount;
  readonly totalFileHints: HintCount;
  readonly totalCrossFileHints: HintCount;
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
  readonly filePath: FilePath;
  readonly relativePath: RelativePath;
  readonly directory: DirectoryPath;
  readonly sourceFile: ts.SourceFile;
  readonly ir: ModuleIR;
  readonly scope: ModuleScope;
  readonly moduleKind: ModuleKind;
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
  readonly maxFlowSteps: StepCount;
  readonly format: 'json' | 'md';
  readonly includeGraph: boolean;
  readonly minPatternOccurrences: OccurrenceCount;
  readonly minDirModules: ModuleCount;
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
