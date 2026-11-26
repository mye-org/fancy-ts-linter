import { flow } from 'fp-ts/lib/function.js';
import * as O from 'fp-ts/lib/Option.js';
import * as RA from 'fp-ts/lib/ReadonlyArray.js';
import * as ts from 'typescript';

export type SourceLocation = {
  readonly line: number;
  readonly column: number;
  readonly endLine: number;
  readonly endColumn: number;
};

export type ErrorCategory =
  | 'tsc'
  | 'structure'
  | 'export-satisfies'
  | 'point-free'
  | 'declarative-purity'
  | 'branching'
  | 'monad'
  | 'optic'
  | 'type-safety';

export type HintCategory =
  | 'adt-over-flags'
  | 'newtype-brand'
  | 'pattern-matching-depth'
  | 'declarative-combinator'
  | 'inference-hygiene'
  | 'monad'
  | 'optic'
  | 'ddd-decomposition'
  | 'arity-strategy';

export type HintPriority = 'high' | 'medium' | 'low';

export type DiagnosticError = {
  readonly ruleId: string;
  readonly category: ErrorCategory;
  readonly location: SourceLocation;
  readonly message: string;
  readonly snippet: string;
  readonly fixGuidance: string;
};

export type AgentHint = {
  readonly hintId: string;
  readonly category: HintCategory;
  readonly priority: HintPriority;
  readonly location: { readonly line: number; readonly column: number };
  readonly evidence: string;
  readonly suggestion: string;
  readonly suggestedSignature: O.Option<string>;
  readonly researchQuestions: ReadonlyArray<string>;
};

export type NodeKind =
  | 'exported-flow'
  | 'sub-flow'
  | 'partial-app'
  | 'leaf-fn'
  | 'optic'
  | 'adt-matcher'
  | 'typeclass-instance'
  | 'other';

export type TypeFlowNode = {
  readonly name: string;
  readonly kind: NodeKind;
  readonly signature: string;
  readonly effects: ReadonlyArray<string>;
  readonly stepCount: O.Option<number>;
};

export type TypeFlowEdge = {
  readonly from: string;
  readonly to: string;
  readonly role: 'flow-step' | 'applies' | 'uses';
};

export type TypeFlowGraph = {
  readonly nodes: ReadonlyArray<TypeFlowNode>;
  readonly edges: ReadonlyArray<TypeFlowEdge>;
};

export type AnalysisSummary = {
  readonly errorCount: number;
  readonly hintCount: number;
  readonly exportedFunction: O.Option<string>;
  readonly exportedSignature: O.Option<string>;
};

export type AnalysisReport = {
  readonly filePath: string;
  readonly passed: boolean;
  readonly summary: AnalysisSummary;
  readonly errors: ReadonlyArray<DiagnosticError>;
  readonly hints: ReadonlyArray<AgentHint>;
  readonly typeFlowGraph: TypeFlowGraph;
};

export type OutputFormat = 'json' | 'md';

export type AnalyzeOptions = {
  readonly tsconfigPath: O.Option<string>;
  readonly maxFlowSteps: number;
  readonly format: OutputFormat;
  readonly includeGraph?: boolean;
  readonly minPatternOccurrences?: number;
  readonly minDirModules?: number;
  readonly excludePatterns?: ReadonlyArray<string>;
};

export type ImportInfo = {
  readonly moduleSpecifier: string;
  readonly defaultImport: O.Option<string>;
  readonly namespaceImport: O.Option<string>;
  readonly namedImports: ReadonlyArray<string>;
  readonly isTypeOnly: boolean;
};

export type FieldInfo = {
  readonly name: string;
  readonly typeText: string;
  readonly isBoolean: boolean;
  readonly isOptional: boolean;
  readonly isNullable: boolean;
  readonly isRawString: boolean;
  readonly isRawNumber: boolean;
  readonly isNewtype: boolean;
};

export type TypeDeclInfo = {
  readonly name: string;
  readonly isExported: boolean;
  readonly isNewtype: boolean;
  readonly isDiscriminatedUnion: boolean;
  readonly fields: ReadonlyArray<FieldInfo>;
  readonly location: SourceLocation;
  readonly node: ts.TypeAliasDeclaration | ts.InterfaceDeclaration;
};

export type BindingInfo = {
  readonly name: string;
  readonly isExported: boolean;
  readonly kind: NodeKind;
  readonly hasSatisfies: boolean;
  readonly hasExplicitReturnType: boolean;
  readonly signature: string;
  readonly effects: ReadonlyArray<string>;
  readonly stepCount: O.Option<number>;
  readonly location: SourceLocation;
  readonly declaration: ts.VariableDeclaration;
  readonly statement: ts.VariableStatement;
  readonly initializer: O.Option<ts.Expression>;
};

export type ModuleIR = {
  readonly filePath: string;
  readonly imports: ReadonlyArray<ImportInfo>;
  readonly typeDeclarations: ReadonlyArray<TypeDeclInfo>;
  readonly bindings: ReadonlyArray<BindingInfo>;
  readonly edges: ReadonlyArray<TypeFlowEdge>;
  readonly typeFlowGraph: TypeFlowGraph;
};

export type TypeInspector = {
  readonly getLocation: (sourceFile: ts.SourceFile) => (node: ts.Node) => SourceLocation;
  readonly getSnippet: (sourceFile: ts.SourceFile) => (node: ts.Node) => string;
  readonly unwrapSatisfiesAndParens: (expr: ts.Expression) => ts.Expression;
  readonly isFlowCall: (node: ts.Node) => boolean;
  readonly isPipeCall: (node: ts.Node) => boolean;
  readonly isUnaryFunctionType: (type: ts.Type) => boolean;
  readonly isOpticType: (type: ts.Type) => boolean;
  readonly isTypeclassInstance: (type: ts.Type) => boolean;
  readonly isNewtypeBrand: (type: ts.Type) => boolean;
  readonly isTsPatternMatch: (node: ts.Node) => boolean;
  readonly hasNullablePart: (type: ts.Type) => boolean;
  readonly hasRawPromise: (type: ts.Type) => boolean;
  readonly isBoundaryLiftCall: (node: ts.Node) => boolean;
  readonly detectEffects: (type: ts.Type) => ReadonlyArray<string>;
  readonly formatType: (type: ts.Type) => string;
};

export type RuleContext = {
  readonly sourceFile: ts.SourceFile;
  readonly checker: ts.TypeChecker;
  readonly inspector: TypeInspector;
  readonly ir: ModuleIR;
  readonly options: AnalyzeOptions;
  readonly tscErrors: ReadonlyArray<DiagnosticError>;
};

export type ReportInput = {
  readonly filePath: string;
  readonly errors: ReadonlyArray<DiagnosticError>;
  readonly hints: ReadonlyArray<AgentHint>;
  readonly ir: ModuleIR;
};

export type BuildAnalysisReport = (input: ReportInput) => AnalysisReport;

const isExportedFlowBinding = (binding: BindingInfo) =>
  binding.isExported && binding.kind !== 'other';

const findExportedBinding = (ir: ModuleIR): O.Option<BindingInfo> =>
  RA.findFirst(isExportedFlowBinding)(ir.bindings);

const getBindingName = (b: BindingInfo) => b.name;
const getBindingSignature = (b: BindingInfo) => b.signature;

const toSummary = (input: ReportInput): AnalysisSummary => ({
  errorCount: input.errors.length,
  hintCount: input.hints.length,
  exportedFunction: O.map(getBindingName)(findExportedBinding(input.ir)),
  exportedSignature: O.map(getBindingSignature)(findExportedBinding(input.ir)),
});

const attachSummary = (input: ReportInput) => ({
  input,
  summary: toSummary(input),
});

const assembleReport = ({
  input,
  summary,
}: {
  readonly input: ReportInput;
  readonly summary: AnalysisSummary;
}): AnalysisReport => ({
  filePath: input.filePath,
  passed: input.errors.length === 0,
  summary,
  errors: input.errors,
  hints: input.hints,
  typeFlowGraph: input.ir.typeFlowGraph,
});

export const buildAnalysisReport = flow(
  attachSummary,
  assembleReport,
) satisfies BuildAnalysisReport;
