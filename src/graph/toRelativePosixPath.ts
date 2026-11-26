import * as B from 'fp-ts/lib/boolean.js';
import { Newtype, iso } from 'newtype-ts';
import * as path from 'node:path';

export type RootDir = Newtype<{ readonly RootDir: unique symbol }, string>;
export type FilePath = Newtype<{ readonly FilePath: unique symbol }, string>;

export type RelativePathInput = {
  readonly rootDir: RootDir;
  readonly filePath: FilePath;
};

export type ToRelativePosixPath = (input: RelativePathInput) => string;

const isoRootDir = iso<RootDir>();
const isoFilePath = iso<FilePath>();

const normalizeSlashes = (filePath: string) => filePath.replace(/\\/g, '/');

export const toRelativePosixPath = (({ rootDir, filePath }) => {
  const rawRoot = isoRootDir.unwrap(rootDir);
  const rawFile = isoFilePath.unwrap(filePath);
  const rel = path.relative(rawRoot, rawFile);
  return normalizeSlashes(
    B.match(
      () => path.basename(rawFile),
      () => rel,
    )(rel.length > 0),
  );
}) satisfies ToRelativePosixPath;
