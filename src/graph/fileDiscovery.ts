import * as fs from 'node:fs';
import * as path from 'node:path';

const IGNORED_DIRS = new Set(['node_modules', 'dist', '.git', 'build', 'coverage']);

const DEFAULT_TEST_PATTERNS: ReadonlyArray<RegExp> = [
  /\.test\.[cm]?tsx?$/i,
  /\.spec\.[cm]?tsx?$/i,
  /(?:^|\/)__tests__(?:\/|$)/i,
  /(?:^|\/)test\/fixtures(?:\/|$)/i,
  /(?:^|\/)fixtures(?:\/|$)/i,
];

const normalizeSlashes = (p: string): string => p.replace(/\\/g, '/');

export const isTsSourceFile = (filePath: string): boolean => {
  const normalized = normalizeSlashes(filePath);
  if (normalized.endsWith('.d.ts') || normalized.endsWith('.d.mts') || normalized.endsWith('.d.cts')) {
    return false;
  }
  return /\.[cm]?tsx?$/i.test(normalized);
};

export const isDefaultTestOrFixtureFile = (filePath: string): boolean => {
  const normalized = normalizeSlashes(filePath);
  return DEFAULT_TEST_PATTERNS.some((re) => re.test(normalized));
};

const globToRegExp = (pattern: string): RegExp => {
  const normalized = normalizeSlashes(pattern);
  let escaped = '';
  for (let i = 0; i < normalized.length; i += 1) {
    const ch = normalized[i]!;
    if (ch === '*' && normalized[i + 1] === '*') {
      if (normalized[i + 2] === '/') {
        escaped += '(?:.*/)?';
        i += 2;
      } else {
        escaped += '.*';
        i += 1;
      }
    } else if (ch === '*') {
      escaped += '[^/]*';
    } else if (ch === '?') {
      escaped += '[^/]';
    } else if (/[.+^${}()|[\]\\]/.test(ch)) {
      escaped += `\\${ch}`;
    } else {
      escaped += ch;
    }
  }
  return new RegExp(`(?:^|/)${escaped}(?:$|/)`);
};

export const matchesExcludePatterns = (
  filePath: string,
  excludePatterns: ReadonlyArray<string>,
): boolean => {
  if (excludePatterns.length === 0) {
    return false;
  }
  const normalized = normalizeSlashes(filePath);
  return excludePatterns.some((raw) => {
    const pat = normalizeSlashes(raw).trim();
    if (pat.length === 0) {
      return false;
    }
    if (!pat.includes('*') && !pat.includes('?')) {
      return normalized.includes(pat);
    }
    return globToRegExp(pat).test(normalized);
  });
};

const walkDirectory = (dirPath: string, out: string[]): void => {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) {
        walkDirectory(path.join(dirPath, entry.name), out);
      }
    } else if (entry.isFile()) {
      const fullPath = path.join(dirPath, entry.name);
      if (isTsSourceFile(fullPath)) {
        out.push(path.resolve(fullPath));
      }
    }
  }
};

export const expandTargetPaths = (
  inputPaths: ReadonlyArray<string>,
  excludePatterns: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const expanded: string[] = [];
  const seen = new Set<string>();

  for (const rawPath of inputPaths) {
    const resolved = path.resolve(rawPath);
    let stat: fs.Stats | undefined;
    try {
      stat = fs.statSync(resolved);
    } catch {
      // Preserve unresolved path so programLoader reports a clear missing-file error
      if (!seen.has(resolved)) {
        seen.add(resolved);
        expanded.push(resolved);
      }
      continue;
    }

    if (stat.isDirectory()) {
      const dirFiles: string[] = [];
      walkDirectory(resolved, dirFiles);
      for (const f of dirFiles) {
        if (!matchesExcludePatterns(f, excludePatterns) && !seen.has(f)) {
          seen.add(f);
          expanded.push(f);
        }
      }
    } else if (stat.isFile()) {
      if (!matchesExcludePatterns(resolved, excludePatterns) && !seen.has(resolved)) {
        seen.add(resolved);
        expanded.push(resolved);
      }
    }
  }

  return expanded;
};

export const computeCommonRootDir = (filePaths: ReadonlyArray<string>): string => {
  if (filePaths.length === 0) {
    return process.cwd();
  }
  const splitDirs = filePaths.map((f) => path.dirname(path.resolve(f)).split(path.sep));
  const first = splitDirs[0]!;
  let prefixLen = first.length;
  for (let i = 1; i < splitDirs.length; i += 1) {
    const parts = splitDirs[i]!;
    let j = 0;
    while (j < prefixLen && j < parts.length && parts[j] === first[j]) {
      j += 1;
    }
    prefixLen = j;
  }
  const joined = first.slice(0, prefixLen).join(path.sep);
  return joined.length > 0 ? joined : path.sep;
};

export const toRelativePosixPath = (rootDir: string, filePath: string): string => {
  const rel = path.relative(rootDir, filePath);
  return normalizeSlashes(rel.length > 0 ? rel : path.basename(filePath));
};

export const toRelativeDirectory = (rootDir: string, filePath: string): string => {
  const rel = toRelativePosixPath(rootDir, filePath);
  const dir = path.posix.dirname(rel);
  return dir === '.' ? '.' : dir;
};
