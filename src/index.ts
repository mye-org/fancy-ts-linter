import { flow } from 'fp-ts/lib/function.js';
import * as E from 'fp-ts/lib/Either.js';
import * as O from 'fp-ts/lib/Option.js';
import * as RA from 'fp-ts/lib/ReadonlyArray.js';
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

const analyzeSourceFile =
  (loaded: LoadedProgram) =>
  (inspector: TypeInspector) =>
  (options: AnalyzeOptions) =>
  (sf: ts.SourceFile): AnalysisReport => {
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
    return buildAnalysisReport({
      filePath: sf.fileName,
      errors: runAllRules(ctx),
      hints: runAllHints(ctx),
      ir,
    });
  };

const resolveSourceFile =
  (program: ts.Program) =>
  (filePath: string): E.Either<string, ts.SourceFile> =>
    E.fromOption(() => `Could not load TypeScript source file: ${filePath}`)(
      O.fromNullable(program.getSourceFile(path.resolve(filePath))),
    );

const analyzeWithLoadedProgram =
  (request: AnalyzeRequest) =>
  (loaded: LoadedProgram): E.Either<string, ReadonlyArray<AnalysisReport>> => {
    const inspector = createTypeInspector(loaded.checker);
    return E.traverseArray((fp: string) =>
      E.map(analyzeSourceFile(loaded)(inspector)(request.options))(
        resolveSourceFile(loaded.program)(fp),
      ),
    )(request.filePaths);
  };

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
