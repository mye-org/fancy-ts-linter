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
  readonly getTscErrors: (sf: ts.SourceFile) => ReadonlyArray<DiagnosticError>;
};

export type LoadTargetProgram = (input: LoadProgramInput) => E.Either<string, LoadedProgram>;

type RawTsConfigResult = {
  readonly config?: unknown;
  readonly error?: ts.Diagnostic;
};

const resolveAbsolutePath = (p: string) => path.resolve(p);

const defaultCompilerOptions: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2023,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  strict: true,
  noUncheckedIndexedAccess: true,
  exactOptionalPropertyTypes: true,
  skipLibCheck: true,
  esModuleInterop: true,
};

const findConfigFromFile = (filePath: string): O.Option<string> =>
  O.fromNullable(
    ts.findConfigFile(path.dirname(filePath), ts.sys.fileExists, 'tsconfig.json'),
  );

const findConfigFromFirstFile = (filePaths: ReadonlyArray<string>): O.Option<string> =>
  O.chain(findConfigFromFile)(RA.head(filePaths));

const resolveConfigPath = (input: LoadProgramInput): O.Option<string> =>
  O.alt(constant(findConfigFromFirstFile(input.filePaths)))(
    O.map(resolveAbsolutePath)(input.tsconfigPath),
  );

const readRawTsConfig = (configPath: string): RawTsConfigResult =>
  ts.readConfigFile(configPath, ts.sys.readFile);

const hasNoConfigError = (res: RawTsConfigResult) => res.error === undefined;

const formatReadConfigError = (configPath: string) => (res: RawTsConfigResult) =>
  `Failed to read tsconfig at ${configPath}: ${O.match(
    constant('Unknown error'),
    (d: ts.Diagnostic) => ts.flattenDiagnosticMessageText(d.messageText, '\n'),
  )(O.fromNullable(res.error))}`;

const parseConfigJson = (configPath: string) => (res: RawTsConfigResult): ts.ParsedCommandLine =>
  ts.parseJsonConfigFileContent(res.config, ts.sys, path.dirname(configPath));

const readTsConfig = (configPath: string): E.Either<string, ts.ParsedCommandLine> =>
  flow(
    readRawTsConfig,
    E.fromPredicate(hasNoConfigError, formatReadConfigError(configPath)),
    E.map(parseConfigJson(configPath)),
  )(configPath);

const makeEmptyParsedConfig = (filePaths: ReadonlyArray<string>): E.Either<string, ts.ParsedCommandLine> =>
  E.right({
    options: defaultCompilerOptions,
    fileNames: [...filePaths],
    errors: [],
  });

const resolveParsedConfig = (input: LoadProgramInput) =>
  O.match(
    constant(makeEmptyParsedConfig(input.filePaths)),
    readTsConfig,
  )(resolveConfigPath(input));

const dedupePaths = RA.uniq(S.Eq);

const toLoadedProgram = (program: ts.Program): LoadedProgram => ({
  program,
  checker: program.getTypeChecker(),
  getTscErrors: collectTscErrorsForFile(program),
});

const createProgramFromOptions =
  (options: ts.CompilerOptions) =>
  (rootNames: ReadonlyArray<string>): ts.Program =>
    ts.createProgram({
      rootNames: [...rootNames],
      options,
    });

const buildProgramWith =
  (filePaths: ReadonlyArray<string>) =>
  (parsed: ts.ParsedCommandLine): LoadedProgram =>
    flow(
      RA.map(resolveAbsolutePath),
      (absTargets) => dedupePaths([...parsed.fileNames, ...absTargets]),
      createProgramFromOptions(parsed.options),
      toLoadedProgram,
    )(filePaths);

const getDiagLength = (diag: ts.Diagnostic) =>
  O.getOrElse(constant(0))(O.fromNullable(diag.length));

const lineCharFromPositions =
  (sf: ts.SourceFile) =>
  (startPos: number) =>
  (endPos: number): SourceLocation => ({
    line: sf.getLineAndCharacterOfPosition(startPos).line + 1,
    column: sf.getLineAndCharacterOfPosition(startPos).character + 1,
    endLine: sf.getLineAndCharacterOfPosition(endPos).line + 1,
    endColumn: sf.getLineAndCharacterOfPosition(endPos).character + 1,
  });

const toDiagnosticLocation =
  (sf: ts.SourceFile) =>
  (diag: ts.Diagnostic): SourceLocation =>
    O.match(
      constant({ line: 1, column: 1, endLine: 1, endColumn: 1 }),
      (start: number) => lineCharFromPositions(sf)(start)(start + getDiagLength(diag)),
    )(O.fromNullable(diag.start));

const sliceSnippet =
  (sf: ts.SourceFile) =>
  (len: number) =>
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
      sliceSnippet(sf)(O.getOrElse(constant(40))(O.fromNullable(diag.length))),
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

const loadFromValidInput = (input: LoadProgramInput): E.Either<string, LoadedProgram> =>
  E.map(buildProgramWith(input.filePaths))(resolveParsedConfig(input));

export const loadTargetProgram = flow(
  ensureNonEmptyTargets,
  E.chain(loadFromValidInput),
) satisfies LoadTargetProgram;
