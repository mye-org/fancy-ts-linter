import * as B from 'fp-ts/lib/boolean.js';
import * as O from 'fp-ts/lib/Option.js';
import * as Ord from 'fp-ts/lib/Ord.js';
import * as RA from 'fp-ts/lib/ReadonlyArray.js';
import * as S from 'fp-ts/lib/string.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isTsSourceFile } from './isTsSourceFile.js';
import { matchesExcludePatterns } from './matchesExcludePatterns.js';

export type ExpandTargetPathsInput = {
  readonly inputPaths: ReadonlyArray<string>;
  readonly excludePatterns: ReadonlyArray<string>;
};

export type ExpandTargetPaths = (input: ExpandTargetPathsInput) => ReadonlyArray<string>;

const direntOrd = Ord.contramap((entry: fs.Dirent) => entry.name)(S.Ord);

const isNotIgnoredDir = (name: string) =>
  name !== 'node_modules' &&
  name !== 'dist' &&
  name !== '.git' &&
  name !== 'build' &&
  name !== 'coverage';

const expandDirEntry = (dirPath: string) => (entry: fs.Dirent): ReadonlyArray<string> =>
  B.match(
    () => [],
    () => walkDirectory(path.join(dirPath, entry.name)),
  )(isNotIgnoredDir(entry.name));

const expandFileEntry = (dirPath: string) => (entry: fs.Dirent): ReadonlyArray<string> => {
  const fullPath = path.join(dirPath, entry.name);
  return B.match(
    () => [],
    () => [path.resolve(fullPath)],
  )(entry.isFile() && isTsSourceFile(fullPath));
};

const expandDirent = (dirPath: string) => (entry: fs.Dirent) =>
  B.match(
    () => expandFileEntry(dirPath)(entry),
    () => expandDirEntry(dirPath)(entry),
  )(entry.isDirectory());

const walkDirectory = (dirPath: string) =>
  RA.chain(expandDirent(dirPath))(
    RA.sortBy([direntOrd])(fs.readdirSync(dirPath, { withFileTypes: true })),
  );

const isNotExcluded = (excludePatterns: ReadonlyArray<string>) => (filePath: string) =>
  !matchesExcludePatterns({ filePath, excludePatterns });

type ExpandStatInput = {
  readonly resolved: string;
  readonly stat: fs.Stats;
  readonly excludePatterns: ReadonlyArray<string>;
};

const expandFileStat = ({ resolved, stat, excludePatterns }: ExpandStatInput) =>
  B.match(
    () => [],
    () => [resolved],
  )(stat.isFile() && isNotExcluded(excludePatterns)(resolved));

const expandStat = ({ resolved, stat, excludePatterns }: ExpandStatInput) =>
  B.match(
    () => expandFileStat({ resolved, stat, excludePatterns }),
    () => RA.filter(isNotExcluded(excludePatterns))(walkDirectory(resolved)),
  )(stat.isDirectory());

type ExpandStatContext = {
  readonly resolved: string;
  readonly excludePatterns: ReadonlyArray<string>;
};

const expandStatWith =
  ({ resolved, excludePatterns }: ExpandStatContext) =>
  (stat: fs.Stats) =>
    expandStat({ resolved, stat, excludePatterns });

const expandSinglePath = (excludePatterns: ReadonlyArray<string>) => (rawPath: string) => {
  const resolved = path.resolve(rawPath);
  return O.match(
    () => [resolved],
    expandStatWith({ resolved, excludePatterns }),
  )(O.fromNullable(fs.statSync(resolved, { throwIfNoEntry: false })));
};

export const expandTargetPaths = (({ inputPaths, excludePatterns }) =>
  RA.uniq(S.Eq)(RA.chain(expandSinglePath(excludePatterns))(inputPaths))) satisfies ExpandTargetPaths;
