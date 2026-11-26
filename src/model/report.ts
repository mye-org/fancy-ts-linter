import { flow } from 'fp-ts/lib/function.js';
import * as O from 'fp-ts/lib/Option.js';
import * as RA from 'fp-ts/lib/ReadonlyArray.js';
import { Newtype, iso } from 'newtype-ts';
import * as ts from 'typescript';

export type LineNumber = Newtype<{ readonly LineNumber: unique symbol }, number>;
export type ColumnNumber = Newtype<{ readonly ColumnNumber: unique symbol }, number>;
export type RuleId = Newtype<{ readonly RuleId: unique symbol }, string>;
export type DiagnosticMessage = Newtype<{ readonly DiagnosticMessage: unique symbol }, string>;
export type CodeSnippet = Newtype<{ readonly CodeSnippet: unique symbol }, string>;
export type FixGuidance = Newtype<{ readonly FixGuidance: unique symbol }, string>;
export type HintId = Newtype<{ readonly HintId: unique symbol }, string>;
export type HintEvidence = Newtype<{ readonly HintEvidence: unique symbol }, string>;
export type HintSuggestion = Newtype<{ readonly HintSuggestion: unique symbol }, string>;
export type SymbolName = Newtype<{ readonly SymbolName: unique symbol }, string>;
export type TypeSignature = Newtype<{ readonly TypeSignature: unique symbol }, string>;
export type ErrorCount = Newtype<{ readonly ErrorCount: unique symbol }, number>;
export type HintCount = Newtype<{ readonly HintCount: unique symbol }, number>;
export type FieldName = Newtype<{ readonly FieldName: unique symbol }, string>;
export type TypeText = Newtype<{ readonly TypeText: unique symbol }, string>;

export type SourceLocation = {
  readonly line: LineNumber;
  readonly column: ColumnNumber;
  readonly endLine: LineNumber;
  readonly endColumn: ColumnNumber;
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
  | 'type-safety'
  | 'test-hygiene';

export type HintCategory =
  | 'adt-over-flags'
  | 'newtype-brand'
  | 'pattern-matching-depth'
  | 'declarative-combinator'
  | 'inference-hygiene'
  | 'monad'
  | 'optic'
  | 'ddd-decomposition'
  | 'arity-strategy'
  | 'test-coverage'
  | 'test-design'
  | 'test-code-smell';

export type HintPriority = 'high' | 'medium' | 'low';

export type DiagnosticError = {
  readonly ruleId: RuleId;
  readonly category: ErrorCategory;
  readonly location: SourceLocation;
  readonly message: DiagnosticMessage;
  readonly snippet: CodeSnippet;
  readonly fixGuidance: FixGuidance;
};

export type AgentHint = {
  readonly hintId: HintId;
  readonly category: HintCategory;
  readonly priority: HintPriority;
  readonly location: { readonly line: LineNumber; readonly column: ColumnNumber };
  readonly evidence: HintEvidence;
  readonly suggestion: HintSuggestion;
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
  readonly name: SymbolName;
  readonly kind: NodeKind;
  readonly signature: TypeSignature;
  readonly effects: ReadonlyArray<string>;
  readonly stepCount: O.Option<number>;
};

export type TypeFlowEdge = {
  readonly from: SymbolName;
  readonly to: SymbolName;
  readonly role: 'flow-step' | 'applies' | 'uses';
};

export type TypeFlowGraph = {
  readonly nodes: ReadonlyArray<TypeFlowNode>;
  readonly edges: ReadonlyArray<TypeFlowEdge>;
};

export type AnalysisSummary = {
  readonly errorCount: ErrorCount;
  readonly hintCount: HintCount;
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
  readonly includeGraph: O.Option<boolean>;
  readonly minPatternOccurrences: O.Option<number>;
  readonly minDirModules: O.Option<number>;
  readonly excludePatterns: O.Option<ReadonlyArray<string>>;
};

export type ImportInfo = {
  readonly moduleSpecifier: string;
  readonly defaultImport: O.Option<string>;
  readonly namespaceImport: O.Option<string>;
  readonly namedImports: ReadonlyArray<string>;
  readonly isTypeOnly: boolean;
};

export type FieldPrimitiveKind = 'boolean' | 'raw-string' | 'raw-number' | 'newtype' | 'other';
export type FieldNullability = 'required' | 'optional' | 'nullable' | 'optional-nullable';

export type FieldInfo = {
  readonly name: FieldName;
  readonly typeText: TypeText;
  readonly kind: FieldPrimitiveKind;
  readonly nullability: FieldNullability;
};

export type DeclarationVisibility = 'exported' | 'private';
export type TypeDeclKind = 'newtype' | 'discriminated-union' | 'standard';

export type TypeDeclInfo = {
  readonly name: string;
  readonly visibility: DeclarationVisibility;
  readonly declKind: TypeDeclKind;
  readonly fields: ReadonlyArray<FieldInfo>;
  readonly location: SourceLocation;
  readonly node: ts.TypeAliasDeclaration | ts.InterfaceDeclaration;
};

export type BindingAnnotationKind = 'none' | 'satisfies' | 'explicit-return' | 'both';

export type BindingInfo = {
  readonly name: SymbolName;
  readonly visibility: DeclarationVisibility;
  readonly kind: NodeKind;
  readonly annotation: BindingAnnotationKind;
  readonly signature: TypeSignature;
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
  readonly getSnippet: (sourceFile: ts.SourceFile) => (node: ts.Node) => CodeSnippet;
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
  binding.visibility === 'exported' && binding.kind !== 'other';

const findExportedBinding = (ir: ModuleIR): O.Option<BindingInfo> =>
  RA.findFirst(isExportedFlowBinding)(ir.bindings);

const isoSymbolName = iso<SymbolName>();
const isoTypeSignature = iso<TypeSignature>();
const getBindingName = (b: BindingInfo) => isoSymbolName.unwrap(b.name);
const getBindingSignature = (b: BindingInfo) => isoTypeSignature.unwrap(b.signature);

const isoErrorCount = iso<ErrorCount>();
const isoHintCount = iso<HintCount>();

const toSummary = (input: ReportInput) => ({
  errorCount: isoErrorCount.wrap(input.errors.length),
  hintCount: isoHintCount.wrap(input.hints.length),
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
}) => ({
  filePath: input.filePath,
  passed: isoErrorCount.unwrap(summary.errorCount) === 0,
  summary,
  errors: input.errors,
  hints: input.hints,
  typeFlowGraph: input.ir.typeFlowGraph,
});

export const buildAnalysisReport = flow(
  attachSummary,
  assembleReport,
) satisfies BuildAnalysisReport;
