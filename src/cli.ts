import * as Apply from 'fp-ts/lib/Apply.js';
import * as B from 'fp-ts/lib/boolean.js';
import * as E from 'fp-ts/lib/Either.js';
import { constant } from 'fp-ts/lib/function.js';
import * as O from 'fp-ts/lib/Option.js';
import * as RA from 'fp-ts/lib/ReadonlyArray.js';
import { parseArgs } from 'node:util';
import { match, P } from 'ts-pattern';
import {
  analyzeFiles,
  type AnalyzeOptions,
  type OutputFormat,
  type ProjectAnalysisReport,
} from './index.js';
import { formatJsonReports } from './reporters/jsonReporter.js';
import { formatMarkdownReports } from './reporters/markdownReporter.js';

export type CliResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

export type RunCli = (argv: ReadonlyArray<string>) => CliResult;

type ParsedCli =
  | { readonly _tag: 'Help' }
  | {
      readonly _tag: 'Run';
      readonly filePaths: ReadonlyArray<string>;
      readonly options: AnalyzeOptions;
    };

type ParsePositiveIntInput = {
  readonly flag: string;
  readonly raw: O.Option<string>;
  readonly defaultVal: number;
  readonly minVal: number;
};

type FormatOutputInput = {
  readonly format: OutputFormat;
  readonly report: ProjectAnalysisReport;
};

type RawParsedArgs = {
  readonly values: Readonly<Record<string, unknown>>;
  readonly positionals: ReadonlyArray<string>;
};

type ValidatedCliNumbers = {
  readonly format: OutputFormat;
  readonly maxFlowSteps: number;
  readonly minPatternOccurrences: number;
  readonly minDirModules: number;
};

type RunCliBase = {
  readonly filePaths: ReadonlyArray<string>;
  readonly tsconfigPath: O.Option<string>;
  readonly includeGraph: boolean;
  readonly excludePatterns: ReadonlyArray<string>;
};

const getHelpText = constant(
  [
    'Usage: fancy-ts-linter <file-or-dir...> [options]',
    '',
    'Options:',
    '  --tsconfig <path>                Path to tsconfig.json (auto-discovered if omitted)',
    '  --format <json|md>               Output format: json (default) or md',
    '  --max-flow-steps <n>             Step threshold for DDD decomposition hint (default: 10)',
    '  --include-graph                  Include full project DAG nodes/edges in output (default: false)',
    '  --min-pattern-occurrences <n>    Minimum files for cross-file pattern discovery (default: 3)',
    '  --min-dir-modules <n>            Minimum modules in a dir for junk-drawer analysis (default: 3)',
    '  --exclude <pattern>              Glob or substring path pattern to exclude (repeatable)',
    '  --help                           Show this help message',
  ].join('\n'),
);

const toNone = constant(O.none);
const emptyStrings = constant(RA.zero<string>());
const identityStrings = (arr: ReadonlyArray<string>) => arr;
const getErrorMessage = (e: Error) => e.message;

const toErrorMessage = (err: unknown) =>
  match(err).with(P.instanceOf(Error), getErrorMessage).otherwise(String);

const asOptionalString = (val: unknown): O.Option<string> =>
  match(val).with(P.string, O.some).otherwise(toNone);

const asStringArray = (val: unknown) =>
  match(val).with(P.array(P.string), identityStrings).otherwise(emptyStrings);

const parseFormatValue = (raw: string): E.Either<string, OutputFormat> =>
  match(raw)
    .with('json', () => E.right<string, OutputFormat>('json'))
    .with('md', () => E.right<string, OutputFormat>('md'))
    .otherwise(() => E.left(`Invalid --format "${raw}". Expected "json" or "md".`));

const parseFormat = O.match(constant(E.right<string, OutputFormat>('json')), parseFormatValue);

const parsePositiveIntValue =
  ({ flag, minVal }: { readonly flag: string; readonly minVal: number }) =>
  (raw: string): E.Either<string, number> => {
    const n = Number(raw);
    return B.match(
      () => E.left(`Invalid ${flag} "${raw}". Expected integer >= ${minVal}.`),
      () => E.right(n),
    )(Number.isInteger(n) && n >= minVal);
  };

const parsePositiveInt = ({
  flag,
  raw,
  defaultVal,
  minVal,
}: ParsePositiveIntInput): E.Either<string, number> =>
  O.match(
    () => E.right<string, number>(defaultVal),
    parsePositiveIntValue({ flag, minVal }),
  )(raw);

const parseNodeArgs = (argv: ReadonlyArray<string>) =>
  parseArgs({
    args: argv.slice(2),
    allowPositionals: true,
    options: {
      tsconfig: { type: 'string' },
      format: { type: 'string' },
      'max-flow-steps': { type: 'string' },
      'include-graph': { type: 'boolean' },
      'min-pattern-occurrences': { type: 'string' },
      'min-dir-modules': { type: 'string' },
      exclude: { type: 'string', multiple: true },
      help: { type: 'boolean', short: 'h' },
    },
  });

const parseRawArgs = E.tryCatchK(parseNodeArgs, toErrorMessage);

const toRunCli =
  (base: RunCliBase) =>
  (opts: ValidatedCliNumbers): ParsedCli => ({
    _tag: 'Run',
    filePaths: base.filePaths,
    options: {
      tsconfigPath: base.tsconfigPath,
      maxFlowSteps: opts.maxFlowSteps,
      format: opts.format,
      includeGraph: O.some(base.includeGraph),
      minPatternOccurrences: O.some(opts.minPatternOccurrences),
      minDirModules: O.some(opts.minDirModules),
      excludePatterns: O.some(base.excludePatterns),
    },
  });

const buildRunCli = (parsed: RawParsedArgs): E.Either<string, ParsedCli> => {
  const values = parsed.values;
  const format = parseFormat(asOptionalString(values.format));
  const maxFlowSteps = parsePositiveInt({
    flag: '--max-flow-steps',
    raw: asOptionalString(values['max-flow-steps']),
    defaultVal: 10,
    minVal: 2,
  });
  const minPatternOccurrences = parsePositiveInt({
    flag: '--min-pattern-occurrences',
    raw: asOptionalString(values['min-pattern-occurrences']),
    defaultVal: 3,
    minVal: 2,
  });
  const minDirModules = parsePositiveInt({
    flag: '--min-dir-modules',
    raw: asOptionalString(values['min-dir-modules']),
    defaultVal: 3,
    minVal: 2,
  });
  const base: RunCliBase = {
    filePaths: parsed.positionals,
    tsconfigPath: asOptionalString(values.tsconfig),
    includeGraph: values['include-graph'] === true,
    excludePatterns: asStringArray(values.exclude),
  };

  return E.map(toRunCli(base))(
    Apply.sequenceS(E.Applicative)({
      format,
      maxFlowSteps,
      minPatternOccurrences,
      minDirModules,
    }),
  );
};

const validateAndBuildCli = (parsed: RawParsedArgs): E.Either<string, ParsedCli> =>
  B.match(
    () =>
      B.match(
        () => buildRunCli(parsed),
        () => E.left<string, ParsedCli>('No input files provided. Run with --help for usage.'),
      )(parsed.positionals.length === 0),
    () => E.right<string, ParsedCli>({ _tag: 'Help' }),
  )(parsed.values.help === true);

const parseCliArgs = (argv: ReadonlyArray<string>): E.Either<string, ParsedCli> =>
  E.chain(validateAndBuildCli)(parseRawArgs(argv));

const formatOutput = ({ format, report }: FormatOutputInput) =>
  match(format)
    .with('md', () => formatMarkdownReports(report))
    .with('json', () => formatJsonReports(report))
    .exhaustive();

const toCliError = (stderr: string) => ({
  exitCode: 2,
  stdout: '',
  stderr,
});

const toCliReportResult =
  (format: OutputFormat) =>
  (report: ProjectAnalysisReport): CliResult => ({
    exitCode: B.match(
      () => 1,
      () => 0,
    )(report.passed),
    stdout: formatOutput({ format, report }),
    stderr: '',
  });

const executeHelpCli = constant({
  exitCode: 0,
  stdout: getHelpText(),
  stderr: '',
});

const executeRunCli = ({
  filePaths,
  options,
}: Extract<ParsedCli, { readonly _tag: 'Run' }>) =>
  E.match(
    toCliError,
    toCliReportResult(options.format),
  )(analyzeFiles({ filePaths, options }));

const executeParsedCli = (parsed: ParsedCli) =>
  match(parsed)
    .with({ _tag: 'Help' }, executeHelpCli)
    .with({ _tag: 'Run' }, executeRunCli)
    .exhaustive();

export const runCli = ((argv) =>
  E.match(toCliError, executeParsedCli)(parseCliArgs(argv))) satisfies RunCli;
