import * as E from 'fp-ts/Either';
import * as O from 'fp-ts/Option';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { analyzeFiles, type AnalyzeOptions, type ProjectAnalysisReport } from '../../src/index.js';

const tempDirs: string[] = [];

export const createTempProject = (files: Record<string, string>) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fancy-ts-test-rules-'));
  tempDirs.push(dir);
  fs.writeFileSync(
    path.join(dir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        noEmit: true,
      },
      include: ['./**/*.ts'],
    }),
  );
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
};

export const cleanupTempProjects = () => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

export const analyzeInTempDir = (dir: string, targetRel: string) => {
  const options: AnalyzeOptions = {
    tsconfigPath: O.some(path.join(dir, 'tsconfig.json')),
    maxFlowSteps: 10,
    format: 'json',
    includeGraph: O.none,
    minPatternOccurrences: O.none,
    minDirModules: O.none,
    excludePatterns: O.none,
  };
  const res = analyzeFiles({
    filePaths: [path.join(dir, targetRel)],
    options,
  });
  return E.match(
    (err: string) => {
      throw new Error(`Unexpected Left: ${err}`);
    },
    (report: ProjectAnalysisReport) => {
      const fileReport = report.files[0];
      if (fileReport === undefined) {
        throw new Error('Expected 1 report');
      }
      return fileReport;
    },
  )(res);
};

export const analyzeMissingFile = (dir: string, targetRel: string) =>
  analyzeFiles({
    filePaths: [path.join(dir, targetRel)],
    options: {
      tsconfigPath: O.some(path.join(dir, 'tsconfig.json')),
      maxFlowSteps: 10,
      format: 'json',
      includeGraph: O.none,
      minPatternOccurrences: O.none,
      minDirModules: O.none,
      excludePatterns: O.none,
    },
  });
