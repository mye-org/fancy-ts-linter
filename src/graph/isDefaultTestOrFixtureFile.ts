import * as RA from 'fp-ts/lib/ReadonlyArray.js';

export type IsDefaultTestOrFixtureFile = (filePath: string) => boolean;

const normalizeSlashes = (filePath: string) => filePath.replace(/\\/g, '/');

const matchesPattern = (normalized: string) => (re: RegExp) => re.test(normalized);

export const isDefaultTestOrFixtureFile = ((filePath) => {
  const normalized = normalizeSlashes(filePath);
  const patterns: ReadonlyArray<RegExp> = [
    /\.test\.[cm]?tsx?$/i,
    /\.spec\.[cm]?tsx?$/i,
    /(?:^|\/)__tests__(?:\/|$)/i,
    /(?:^|\/)test\/fixtures(?:\/|$)/i,
    /(?:^|\/)fixtures(?:\/|$)/i,
  ];
  return RA.some(matchesPattern(normalized))(patterns);
}) satisfies IsDefaultTestOrFixtureFile;
