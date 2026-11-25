import { constant, flow } from 'fp-ts/lib/function.js';
import * as E from 'fp-ts/lib/Either.js';
import * as O from 'fp-ts/lib/Option.js';
import * as RA from 'fp-ts/lib/ReadonlyArray.js';
import { parseArgs } from 'node:util';
import { match, P } from 'ts-pattern';
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

type RawCliInput =
  | { readonly _tag: 'HelpRequested' }
  | {
      readonly _tag: 'LintRequested';
      readonly tsconfig: O.Option<string>;
      readonly format: O.Option<string>;
      readonly maxFlowSteps: O.Option<string>;
      readonly positionals: ReadonlyArray<string>;
    };

type LintRequestedInput = Extract<RawCliInput, { readonly _tag: 'LintRequested' }>;

const getHelpText = (_: ParsedCli) =>
  [
    'Usage: fancy-ts-linter <file...> [options]',
    '',
    'Options:',
    '  --tsconfig <path>       Path to tsconfig.json (auto-discovered if omitted)',
    '  --format <json|md>      Output format: json (default) or md',
    '  --max-flow-steps <n>    Step threshold for DDD decomposition hint (default: 10)',
    '  --help                  Show this help message',
  ].join('\n');

const isOutputFormat = (v: string) => v === 'json' || v === 'md';
const invalidFormatMsg = (v: string) => `Invalid --format "${v}". Expected "json" or "md".`;
const validateFormat = E.fromPredicate(isOutputFormat, invalidFormatMsg);

const parseFormat = O.match(
  constant(E.right<string, OutputFormat>('json')),
  validateFormat,
);

const isValidMaxSteps = (n: number) => Number.isInteger(n) && n >= 2;
const parseStepNumber = (v: string) =>
  E.fromPredicate(
    isValidMaxSteps,
    constant(`Invalid --max-flow-steps "${v}". Expected integer >= 2.`),
  )(Number(v));

const parseMaxSteps = O.match(
  constant(E.right<string, number>(10)),
  parseStepNumber,
);

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

const getErrMessage = (err: Error) => err.message;

const toErrorMessage = (err: unknown) =>
  match(err)
    .with(P.instanceOf(Error), getErrMessage)
    .otherwise(String);

const toLintRequested =
  (positionals: ReadonlyArray<string>) =>
  (values: ReturnType<typeof invokeParseArgs>['values']) => ({
    _tag: 'LintRequested' as const,
    tsconfig: O.fromNullable(values.tsconfig),
    format: O.fromNullable(values.format),
    maxFlowSteps: O.fromNullable(values['max-flow-steps']),
    positionals,
  });

const toRawCliInput = (raw: ReturnType<typeof invokeParseArgs>) =>
  match(raw)
    .with({ values: { help: true } }, constant({ _tag: 'HelpRequested' } as const))
    .otherwise(constant(toLintRequested(raw.positionals)(raw.values)));

const parseRawArgs = (argv: ReadonlyArray<string>) =>
  E.map(toRawCliInput)(E.tryCatch(flow(constant(argv), invokeParseArgs), toErrorMessage));

const toHelpCli = (_: RawCliInput) => ({
  help: true,
  filePaths: RA.empty,
  options: { tsconfigPath: O.none, maxFlowSteps: 10, format: 'json' as const },
});

const buildAnalyzeOptions =
  (raw: { readonly tsconfigPath: O.Option<string>; readonly format: OutputFormat }) =>
  (maxFlowSteps: number): AnalyzeOptions => ({
    tsconfigPath: raw.tsconfigPath,
    maxFlowSteps,
    format: raw.format,
  });

const parseMaxStepsWithFormat =
  (input: LintRequestedInput) =>
  (format: OutputFormat) =>
    E.map(
      buildAnalyzeOptions({
        tsconfigPath: input.tsconfig,
        format,
      }),
    )(parseMaxSteps(input.maxFlowSteps));

const parseOptions = (input: LintRequestedInput) =>
  E.chain(parseMaxStepsWithFormat(input))(parseFormat(input.format));

const toParsedCli =
  (filePaths: ReadonlyArray<string>) =>
  (options: AnalyzeOptions): ParsedCli => ({
    help: false,
    filePaths,
    options,
  });

const validatePositionals = (input: LintRequestedInput) =>
  E.map(toParsedCli(input.positionals))(parseOptions(input));

const validateParsedArgs = (input: RawCliInput) =>
  match(input)
    .with({ _tag: 'HelpRequested' }, flow(toHelpCli, E.right<string, ParsedCli>))
    .with(
      { _tag: 'LintRequested', positionals: [] },
      constant(E.left<string, ParsedCli>('No input files provided. Run with --help for usage.')),
    )
    .with({ _tag: 'LintRequested' }, validatePositionals)
    .exhaustive();

const parseCliArgs = flow(
  parseRawArgs,
  E.chain(validateParsedArgs),
);

const formatOutput = (format: OutputFormat) =>
  match(format)
    .with('md', constant(formatMarkdownReports))
    .with('json', constant(formatJsonReports))
    .exhaustive();

const isReportPassed = (r: AnalysisReport) => r.passed;
const allReportsPassed = RA.every(isReportPassed);

const toErrorCliResult = (stderr: string) => ({
  exitCode: 2,
  stdout: '',
  stderr,
});

const toSuccessCliResult =
  (format: OutputFormat) =>
  (reports: ReadonlyArray<AnalysisReport>): CliResult => ({
    exitCode: match(allReportsPassed(reports))
      .with(true, constant(0))
      .with(false, constant(1))
      .exhaustive(),
    stdout: formatOutput(format)(reports),
    stderr: '',
  });

const runAnalysisCli = (parsed: ParsedCli) =>
  E.match(toErrorCliResult, toSuccessCliResult(parsed.options.format))(
    analyzeFiles({ filePaths: parsed.filePaths, options: parsed.options }),
  );

const toHelpCliResult = (parsed: ParsedCli) => ({
  exitCode: 0,
  stdout: getHelpText(parsed),
  stderr: '',
});

const executeParsedCli = (parsed: ParsedCli) =>
  match(parsed)
    .with({ help: true }, toHelpCliResult)
    .otherwise(runAnalysisCli);

const toCliResult = E.match(toErrorCliResult, executeParsedCli);

export const runCli = flow(
  parseCliArgs,
  toCliResult,
) satisfies RunCli;
