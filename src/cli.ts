import { constant, flow } from 'fp-ts/lib/function.js';
import * as E from 'fp-ts/lib/Either.js';
import * as O from 'fp-ts/lib/Option.js';
import * as RA from 'fp-ts/lib/ReadonlyArray.js';
import { parseArgs } from 'node:util';
import { analyzeFiles, type AnalysisReport, type AnalyzeOptions, type OutputFormat } from './index.js';
import { formatJsonReports } from './reporters/jsonReporter.js';
import { formatMarkdownReports } from './reporters/markdownReporter.js';

export type CliResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

export type RunCli = (argv: ReadonlyArray<string>) => CliResult;

type ParsedCli = {
  readonly help: boolean;
  readonly filePaths: ReadonlyArray<string>;
  readonly options: AnalyzeOptions;
};

const helpText = [
  'Usage: fancy-ts-linter <file...> [options]',
  '',
  'Options:',
  '  --tsconfig <path>       Path to tsconfig.json (auto-discovered if omitted)',
  '  --format <json|md>      Output format: json (default) or md',
  '  --max-flow-steps <n>    Step threshold for DDD decomposition hint (default: 10)',
  '  --help                  Show this help message',
].join('\n');

const parseFormat = (raw: O.Option<string>): E.Either<string, OutputFormat> =>
  O.match(
    constant(E.right<string, OutputFormat>('json')),
    (v: string) =>
      v === 'json' || v === 'md'
        ? E.right<string, OutputFormat>(v)
        : E.left<string, OutputFormat>(`Invalid --format "${v}". Expected "json" or "md".`),
  )(raw);

const parseMaxSteps = (raw: O.Option<string>): E.Either<string, number> =>
  O.match(
    constant(E.right<string, number>(10)),
    (v: string) => {
      const n = Number(v);
      return Number.isInteger(n) && n >= 2
        ? E.right<string, number>(n)
        : E.left<string, number>(`Invalid --max-flow-steps "${v}". Expected integer >= 2.`);
    },
  )(raw);

const invokeParseArgs = (argv: ReadonlyArray<string>) =>
  parseArgs({
    args: argv.slice(2),
    allowPositionals: true,
    options: {
      tsconfig: { type: 'string' },
      format: { type: 'string' },
      'max-flow-steps': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });

const parseRawArgs = (argv: ReadonlyArray<string>) =>
  E.tryCatch(
    () => invokeParseArgs(argv),
    (err) => (err instanceof Error ? err.message : String(err)),
  );

const validateParsedArgs = (
  parsed: ReturnType<typeof invokeParseArgs>,
): E.Either<string, ParsedCli> => {
  if (parsed.values.help === true) {
    return E.right<string, ParsedCli>({
      help: true,
      filePaths: [],
      options: { tsconfigPath: O.none, maxFlowSteps: 10, format: 'json' },
    });
  }
  if (parsed.positionals.length === 0) {
    return E.left<string, ParsedCli>('No input files provided. Run with --help for usage.');
  }
  return E.chain((format: OutputFormat) =>
    E.map((maxFlowSteps: number): ParsedCli => ({
      help: false,
      filePaths: parsed.positionals,
      options: {
        tsconfigPath: O.fromNullable(parsed.values.tsconfig),
        maxFlowSteps,
        format,
      },
    }))(parseMaxSteps(O.fromNullable(parsed.values['max-flow-steps']))),
  )(parseFormat(O.fromNullable(parsed.values.format)));
};

const parseCliArgs = flow(
  parseRawArgs,
  E.chain(validateParsedArgs),
);

const formatOutput =
  (format: OutputFormat) =>
  (reports: ReadonlyArray<AnalysisReport>): string =>
    format === 'md' ? formatMarkdownReports(reports) : formatJsonReports(reports);

const executeParsedCli = (parsed: ParsedCli): CliResult => {
  if (parsed.help) {
    return { exitCode: 0, stdout: helpText, stderr: '' };
  }
  return E.match(
    (err: string): CliResult => ({ exitCode: 2, stdout: '', stderr: err }),
    (reports: ReadonlyArray<AnalysisReport>): CliResult => ({
      exitCode: RA.every((r: AnalysisReport) => r.passed)(reports) ? 0 : 1,
      stdout: formatOutput(parsed.options.format)(reports),
      stderr: '',
    }),
  )(analyzeFiles({ filePaths: parsed.filePaths, options: parsed.options }));
};

const toCliResult = (parsedEither: E.Either<string, ParsedCli>): CliResult =>
  E.match(
    (err: string): CliResult => ({ exitCode: 2, stdout: '', stderr: err }),
    executeParsedCli,
  )(parsedEither);

export const runCli = flow(
  parseCliArgs,
  toCliResult,
) satisfies RunCli;
