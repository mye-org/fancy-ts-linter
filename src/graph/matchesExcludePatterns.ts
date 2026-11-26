import * as B from 'fp-ts/lib/boolean.js';
import * as RA from 'fp-ts/lib/ReadonlyArray.js';
import { match } from 'ts-pattern';

export type MatchesExcludePatternsInput = {
  readonly filePath: string;
  readonly excludePatterns: ReadonlyArray<string>;
};

export type MatchesExcludePatterns = (input: MatchesExcludePatternsInput) => boolean;

const normalizeSlashes = (filePath: string) => filePath.replace(/\\/g, '/');

const escapeRegexChar = (ch: string) => `\\${ch}`;

const replaceGlobToken = (token: string) =>
  match(token)
    .with('**/', () => '(?:.*/)?')
    .with('**', () => '.*')
    .with('*', () => '[^/]*')
    .with('?', () => '[^/]')
    .otherwise(escapeRegexChar);

const globToRegExp = (pattern: string) => {
  const escaped = normalizeSlashes(pattern).replace(
    /(\*\*\/|\*\*|\*|\?|[.+^${}()|[\]\\])/g,
    replaceGlobToken,
  );
  return new RegExp(`(?:^|/)${escaped}(?:$|/)`);
};

const matchesSinglePattern = (normalizedPath: string) => (rawPattern: string) => {
  const pat = normalizeSlashes(rawPattern).trim();
  return B.match(
    () => false,
    () =>
      B.match(
        () => globToRegExp(pat).test(normalizedPath),
        () => normalizedPath.includes(pat),
      )(!pat.includes('*') && !pat.includes('?')),
  )(pat.length === 0);
};

export const matchesExcludePatterns = (({ filePath, excludePatterns }) =>
  B.match(
    () => false,
    () => RA.some(matchesSinglePattern(normalizeSlashes(filePath)))(excludePatterns),
  )(excludePatterns.length === 0)) satisfies MatchesExcludePatterns;
