import * as RA from 'fp-ts/lib/ReadonlyArray.js';

export type IsUnitTestFile = (filePath: string) => boolean;

const normalizeSlashes = (filePath: string) => filePath.replace(/\\/g, '/');

const matchesPattern = (normalized: string) => (re: RegExp) => re.test(normalized);

const isFixturePath = (normalized: string) =>
  /(?:^|\/)test\/fixtures(?:\/|$)/i.test(normalized) ||
  /(?:^|\/)fixtures(?:\/|$)/i.test(normalized);

export const isUnitTestFile = ((filePath) => {
  const normalized = normalizeSlashes(filePath);
  const testPatterns: ReadonlyArray<RegExp> = [
    /\.test\.[cm]?tsx?$/i,
    /\.spec\.[cm]?tsx?$/i,
    /(?:^|\/)__tests__(?:\/|$)/i,
  ];
  return !isFixturePath(normalized) && RA.some(matchesPattern(normalized))(testPatterns);
}) satisfies IsUnitTestFile;
