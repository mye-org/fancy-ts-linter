import * as B from 'fp-ts/lib/boolean.js';
import * as path from 'node:path';

export type RelativePathInput = {
  readonly rootDir: string;
  readonly filePath: string;
};

export type ToRelativePosixPath = (input: RelativePathInput) => string;

const normalizeSlashes = (filePath: string) => filePath.replace(/\\/g, '/');

export const toRelativePosixPath = (({ rootDir, filePath }) => {
  const rel = path.relative(rootDir, filePath);
  return normalizeSlashes(
    B.match(
      () => path.basename(filePath),
      () => rel,
    )(rel.length > 0),
  );
}) satisfies ToRelativePosixPath;
