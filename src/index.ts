import { constant, flow } from 'fp-ts/lib/function.js';
import * as E from 'fp-ts/lib/Either.js';
import * as O from 'fp-ts/lib/Option.js';
import { Lens } from 'monocle-ts';
import * as path from 'node:path';
import * as ts from 'typescript';
import { loadTargetProgram, type LoadedProgram } from './compiler/programLoader.js';
import { createTypeInspector } from './compiler/typeUtils.js';
import { extractModuleIR } from './ir/moduleGraph.js';
import { runAllRules } from './rules/index.js';
import { runAllHints } from './hints/index.js';
import {
  buildAnalysisReport,
  type AnalysisReport,
  type AnalyzeOptions,
  type ModuleIR,
  type RuleContext,
  type TypeInspector,
} from './model/report.js';

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

export type AnalyzeRequest = {
  readonly filePaths: ReadonlyArray<string>;
  readonly options: AnalyzeOptions;
};

export type AnalyzeFiles = (
  request: AnalyzeRequest,
) => E.Either<string, ReadonlyArray<AnalysisReport>>;

type AnalyzeContext = {
  readonly loaded: LoadedProgram;
  readonly inspector: TypeInspector;
  readonly options: AnalyzeOptions;
};

type SourceWithIr = {
  readonly analyzeCtx: AnalyzeContext;
  readonly sf: ts.SourceFile;
  readonly ir: ModuleIR;
};

const checkerLens = Lens.fromPath<AnalyzeContext>()(['loaded', 'checker']);
const programLens = Lens.fromPath<AnalyzeContext>()(['loaded', 'program']);
const getTscErrorsLens = Lens.fromPath<AnalyzeContext>()(['loaded', 'getTscErrors']);
const fileNameLens = Lens.fromPath<RuleContext>()(['sourceFile', 'fileName']);

const extractIrStep =
  (analyzeCtx: AnalyzeContext) =>
  (sf: ts.SourceFile): SourceWithIr => ({
    analyzeCtx,
    sf,
    ir: extractModuleIR({
      sourceFile: sf,
      checker: checkerLens.get(analyzeCtx),
      inspector: analyzeCtx.inspector,
    }),
  });

const toRuleContext = ({ analyzeCtx, sf, ir }: SourceWithIr) => ({
  sourceFile: sf,
  checker: checkerLens.get(analyzeCtx),
  inspector: analyzeCtx.inspector,
  ir,
  options: analyzeCtx.options,
  tscErrors: getTscErrorsLens.get(analyzeCtx)(sf),
});

const buildReportFromRuleCtx = (ctx: RuleContext) =>
  buildAnalysisReport({
    filePath: fileNameLens.get(ctx),
    errors: runAllRules(ctx),
    hints: runAllHints(ctx),
    ir: ctx.ir,
  });

const analyzeSourceFile = (analyzeCtx: AnalyzeContext) =>
  flow(extractIrStep(analyzeCtx), toRuleContext, buildReportFromRuleCtx);

const resolveSourceFile =
  (program: ts.Program) =>
  (filePath: string) =>
    E.fromOption(constant(`Could not load TypeScript source file: ${filePath}`))(
      O.fromNullable(program.getSourceFile(path.resolve(filePath))),
    );

const analyzeFilePath =
  (analyzeCtx: AnalyzeContext) =>
  (fp: string) =>
    E.map(analyzeSourceFile(analyzeCtx))(
      resolveSourceFile(programLens.get(analyzeCtx))(fp),
    );

const toAnalyzeContext =
  (options: AnalyzeOptions) =>
  (loaded: LoadedProgram): AnalyzeContext => ({
    loaded,
    inspector: createTypeInspector(loaded.checker),
    options,
  });

const traverseFiles =
  (filePaths: ReadonlyArray<string>) =>
  (ctx: AnalyzeContext) =>
    E.traverseArray(analyzeFilePath(ctx))(filePaths);

const analyzeWithLoadedProgram = (request: AnalyzeRequest) =>
  flow(toAnalyzeContext(request.options), traverseFiles(request.filePaths));

const loadForRequest = (request: AnalyzeRequest) =>
  E.chain(analyzeWithLoadedProgram(request))(
    loadTargetProgram({
      filePaths: request.filePaths,
      tsconfigPath: request.options.tsconfigPath,
    }),
  );

const passRequest = (request: AnalyzeRequest) => request;

export const analyzeFiles = flow(
  passRequest,
  loadForRequest,
) satisfies AnalyzeFiles;
