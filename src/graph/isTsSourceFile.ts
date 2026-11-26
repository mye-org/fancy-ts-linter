import * as B from 'fp-ts/lib/boolean.js';

export type IsTsSourceFile = (filePath: string) => boolean;

const normalizeSlashes = (filePath: string) => filePath.replace(/\\/g, '/');

const isDeclarationFile = (normalized: string) =>
  normalized.endsWith('.d.ts') ||
  normalized.endsWith('.d.mts') ||
  normalized.endsWith('.d.cts');

const hasTsExtension = (normalized: string) => /\.[cm]?tsx?$/i.test(normalized);

export const isTsSourceFile = ((filePath) => {
  const normalized = normalizeSlashes(filePath);
  return B.match(
    () => hasTsExtension(normalized),
    () => false,
  )(isDeclarationFile(normalized));
}) satisfies IsTsSourceFile;
