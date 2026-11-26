import { constant, flow } from 'fp-ts/lib/function.js';
import * as B from 'fp-ts/lib/boolean.js';
import * as E from 'fp-ts/lib/Either.js';
import * as O from 'fp-ts/lib/Option.js';
import * as RA from 'fp-ts/lib/ReadonlyArray.js';
import * as S from 'fp-ts/lib/string.js';
import * as path from 'node:path';
import * as ts from 'typescript';
import type { DiagnosticError, SourceLocation } from '../model/report.js';

export type LoadProgramInput = {
  readonly filePaths: ReadonlyArray<string>;
  readonly tsconfigPath: O.Option<string>;
};

export type LoadedProgram = {
  readonly program: ts.Program;
  readonly checker: ts.TypeChecker;
  readonly projectBaseDir: string;
  readonly getTscErrors: (sf: ts.SourceFile) => ReadonlyArray<DiagnosticError>;
};

export type LoadTargetProgram = (input: LoadProgramInput) => E.Either<string, LoadedProgram>;

type BuildProgramContext = {
  readonly filePaths: ReadonlyArray<string>;
  readonly projectBaseDir: string;
};

type LineCharInput = {
  readonly sf: ts.SourceFile;
  readonly startPos: number;
  readonly endPos: number;
};

type DiagContext = {
  readonly sf: ts.SourceFile;
  readonly diag: ts.Diagnostic;
};

const findConfigFromFile = (filePath: string): O.Option<string> =>
  O.fromNullable(
    ts.findConfigFile(path.dirname(filePath), ts.sys.fileExists, 'tsconfig.json'),
  );

const findConfigFromFirstFile = (filePaths: ReadonlyArray<string>): O.Option<string> =>
  O.chain(findConfigFromFile)(RA.head(filePaths));

const resolveConfigPath = (input: LoadProgramInput): O.Option<string> =>
  O.alt(constant(findConfigFromFirstFile(input.filePaths)))(
    O.map(path.resolve)(input.tsconfigPath),
  );

const formatTsDiagnostic = (diag: ts.Diagnostic) =>
  ts.flattenDiagnosticMessageText(diag.messageText, '\n');

const formatReadConfigError = (configPath: string) => (diag: ts.Diagnostic) =>
  E.left(`Failed to read tsconfig at ${configPath}: ${formatTsDiagnostic(diag)}`);

const parseRawTsConfig =
  (configPath: string) =>
  (res: ReturnType<typeof ts.readConfigFile>) =>
    O.match(
      () =>
        E.right<string, ts.ParsedCommandLine>(
          ts.parseJsonConfigFileContent(res.config, ts.sys, path.dirname(configPath)),
        ),
      formatReadConfigError(configPath),
    )(O.fromNullable(res.error));

const readRawTsConfig = (configPath: string) =>
  ts.readConfigFile(configPath, ts.sys.readFile);

const readTsConfig = (configPath: string): E.Either<string, ts.ParsedCommandLine> =>
  flow(
    readRawTsConfig,
    parseRawTsConfig(configPath),
  )(configPath);

const makeEmptyParsedConfig = (
  filePaths: ReadonlyArray<string>,
): E.Either<string, ts.ParsedCommandLine> =>
  E.right({
    options: {
      target: ts.ScriptTarget.ES2023,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      strict: true,
      noUncheckedIndexedAccess: true,
      exactOptionalPropertyTypes: true,
      skipLibCheck: true,
      esModuleInterop: true,
    },
    fileNames: [...filePaths],
    errors: [],
  });

const resolveParsedConfig = (input: LoadProgramInput) =>
  O.match(
    () => makeEmptyParsedConfig(input.filePaths),
    readTsConfig,
  )(resolveConfigPath(input));

const dedupePaths = RA.uniq(S.Eq);

const toLoadedProgram =
  (projectBaseDir: string) =>
  (program: ts.Program): LoadedProgram => ({
    program,
    checker: program.getTypeChecker(),
    projectBaseDir,
    getTscErrors: collectTscErrorsForFile(program),
  });

const createProgramFromOptions =
  (options: ts.CompilerOptions) =>
  (rootNames: ReadonlyArray<string>): ts.Program =>
    ts.createProgram({
      rootNames: [...rootNames],
      options,
    });

const mergeWithParsedFiles =
  (parsedFiles: ReadonlyArray<string>) =>
  (absTargets: ReadonlyArray<string>) =>
    dedupePaths([...parsedFiles, ...absTargets]);

const buildProgramWith =
  ({ filePaths, projectBaseDir }: BuildProgramContext) =>
  (parsed: ts.ParsedCommandLine): LoadedProgram =>
    flow(
      RA.map(path.resolve),
      mergeWithParsedFiles(parsed.fileNames),
      createProgramFromOptions(parsed.options),
      toLoadedProgram(projectBaseDir),
    )(filePaths);

const getDiagLength = (diag: ts.Diagnostic) =>
  O.getOrElse(constant(0))(O.fromNullable(diag.length));

const lineCharFromPositions = ({ sf, startPos, endPos }: LineCharInput) => ({
  line: sf.getLineAndCharacterOfPosition(startPos).line + 1,
  column: sf.getLineAndCharacterOfPosition(startPos).character + 1,
  endLine: sf.getLineAndCharacterOfPosition(endPos).line + 1,
  endColumn: sf.getLineAndCharacterOfPosition(endPos).character + 1,
});

const diagLocationFromStart =
  ({ sf, diag }: DiagContext) =>
  (start: number) =>
    lineCharFromPositions({ sf, startPos: start, endPos: start + getDiagLength(diag) });

const toDiagnosticLocation =
  (sf: ts.SourceFile) =>
  (diag: ts.Diagnostic): SourceLocation =>
    O.match(
      constant({ line: 1, column: 1, endLine: 1, endColumn: 1 }),
      diagLocationFromStart({ sf, diag }),
    )(O.fromNullable(diag.start));

const sliceSnippet =
  ({ sf, len }: { readonly sf: ts.SourceFile; readonly len: number }) =>
  (start: number): string =>
    sf.text
      .slice(start, start + Math.min(len, 80))
      .replace(/\s+/g, ' ')
      .trim();

const formatDiagSnippet =
  (sf: ts.SourceFile) =>
  (diag: ts.Diagnostic): string =>
    O.match(
      constant(''),
      sliceSnippet({ sf, len: O.getOrElse(constant(40))(O.fromNullable(diag.length)) }),
    )(O.fromNullable(diag.start));

const mapTscDiagnostic =
  (sf: ts.SourceFile) =>
  (diag: ts.Diagnostic): DiagnosticError => ({
    ruleId: `TS${diag.code}`,
    category: 'tsc',
    location: toDiagnosticLocation(sf)(diag),
    message: ts.flattenDiagnosticMessageText(diag.messageText, ' '),
    snippet: formatDiagSnippet(sf)(diag),
    fixGuidance: 'Resolve the TypeScript compiler diagnostic.',
  });

const collectTscErrorsForFile =
  (program: ts.Program) =>
  (sf: ts.SourceFile): ReadonlyArray<DiagnosticError> =>
    RA.map(mapTscDiagnostic(sf))([
      ...program.getSyntacticDiagnostics(sf),
      ...program.getSemanticDiagnostics(sf),
    ]);

const ensureNonEmptyTargets = (input: LoadProgramInput): E.Either<string, LoadProgramInput> =>
  B.match(
    constant(E.right(input)),
    constant(E.left('No target TypeScript files provided.')),
  )(RA.isEmpty(input.filePaths));

const fallbackBaseDir = (filePaths: ReadonlyArray<string>) =>
  path.dirname(path.resolve(O.getOrElse(process.cwd)(RA.head(filePaths))));

const resolveProjectBaseDir = (input: LoadProgramInput) =>
  O.match(
    () => fallbackBaseDir(input.filePaths),
    path.dirname,
  )(resolveConfigPath(input));

const loadFromValidInput = (input: LoadProgramInput): E.Either<string, LoadedProgram> =>
  E.map(buildProgramWith({ filePaths: input.filePaths, projectBaseDir: resolveProjectBaseDir(input) }))(
    resolveParsedConfig(input),
  );

export const loadTargetProgram = flow(
  ensureNonEmptyTargets,
  E.chain(loadFromValidInput),
) satisfies LoadTargetProgram;
