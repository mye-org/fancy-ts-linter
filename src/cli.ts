import * as E from 'fp-ts/lib/Either.js';
import * as O from 'fp-ts/lib/Option.js';
import { parseArgs } from 'node:util';
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

type ParsedCli = {
  readonly help: boolean;
  readonly filePaths: ReadonlyArray<string>;
  readonly options: AnalyzeOptions;
};

const helpText = [
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
].join('\n');

const parseFormat = (raw: string | undefined): E.Either<string, OutputFormat> => {
  if (raw === undefined) {
    return E.right('json');
  }
  return raw === 'json' || raw === 'md'
    ? E.right(raw)
    : E.left(`Invalid --format "${raw}". Expected "json" or "md".`);
};

const parsePositiveInt = (
  flag: string,
  raw: string | undefined,
  defaultVal: number,
  minVal: number,
): E.Either<string, number> => {
  if (raw === undefined) {
    return E.right(defaultVal);
  }
  const n = Number(raw);
  return Number.isInteger(n) && n >= minVal
    ? E.right(n)
    : E.left(`Invalid ${flag} "${raw}". Expected integer >= ${minVal}.`);
};

const parseCliArgs = (argv: ReadonlyArray<string>): E.Either<string, ParsedCli> => {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
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
  } catch (err) {
    return E.left(err instanceof Error ? err.message : String(err));
  }

  if (parsed.values.help === true) {
    return E.right({
      help: true,
      filePaths: [],
      options: { tsconfigPath: O.none, maxFlowSteps: 10, format: 'json' },
    });
  }

  if (parsed.positionals.length === 0) {
    return E.left('No input files provided. Run with --help for usage.');
  }

  const formatEither = parseFormat(
    typeof parsed.values.format === 'string' ? parsed.values.format : undefined,
  );
  if (E.isLeft(formatEither)) {
    return formatEither;
  }

  const maxStepsEither = parsePositiveInt(
    '--max-flow-steps',
    typeof parsed.values['max-flow-steps'] === 'string'
      ? parsed.values['max-flow-steps']
      : undefined,
    10,
    2,
  );
  if (E.isLeft(maxStepsEither)) {
    return maxStepsEither;
  }

  const minPatternEither = parsePositiveInt(
    '--min-pattern-occurrences',
    typeof parsed.values['min-pattern-occurrences'] === 'string'
      ? parsed.values['min-pattern-occurrences']
      : undefined,
    3,
    2,
  );
  if (E.isLeft(minPatternEither)) {
    return minPatternEither;
  }

  const minDirEither = parsePositiveInt(
    '--min-dir-modules',
    typeof parsed.values['min-dir-modules'] === 'string'
      ? parsed.values['min-dir-modules']
      : undefined,
    3,
    2,
  );
  if (E.isLeft(minDirEither)) {
    return minDirEither;
  }

  const rawExcludes = parsed.values.exclude;
  const excludePatterns: ReadonlyArray<string> = Array.isArray(rawExcludes)
    ? rawExcludes.filter((v): v is string => typeof v === 'string')
    : [];

  const tsconfigVal =
    typeof parsed.values.tsconfig === 'string' ? O.some(parsed.values.tsconfig) : O.none;

  return E.right({
    help: false,
    filePaths: parsed.positionals,
    options: {
      tsconfigPath: tsconfigVal,
      maxFlowSteps: maxStepsEither.right,
      format: formatEither.right,
      includeGraph: parsed.values['include-graph'] === true,
      minPatternOccurrences: minPatternEither.right,
      minDirModules: minDirEither.right,
      excludePatterns,
    },
  });
};

const formatOutput = (format: OutputFormat, report: ProjectAnalysisReport): string =>
  format === 'md' ? formatMarkdownReports(report) : formatJsonReports(report);

export const runCli: RunCli = (argv) => {
  const parsedEither = parseCliArgs(argv);
  if (E.isLeft(parsedEither)) {
    return { exitCode: 2, stdout: '', stderr: parsedEither.left };
  }
  const parsed = parsedEither.right;
  if (parsed.help) {
    return { exitCode: 0, stdout: helpText, stderr: '' };
  }

  const result = analyzeFiles({ filePaths: parsed.filePaths, options: parsed.options });
  if (E.isLeft(result)) {
    return { exitCode: 2, stdout: '', stderr: result.left };
  }

  return {
    exitCode: result.right.passed ? 0 : 1,
    stdout: formatOutput(parsed.options.format, result.right),
    stderr: '',
  };
};
