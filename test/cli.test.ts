import { describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';

describe('CLI runner & reporters', () => {
  it('returns exitCode 0 and valid JSON for canonical fixture', () => {
    const res = runCli([
      'node',
      'cli',
      'test/fixtures/canonical/priceOrder.ts',
      '--format',
      'json',
    ]);
    expect(res.exitCode).toBe(0);
    expect(res.stderr).toBe('');
    const parsed = JSON.parse(res.stdout) as {
      passed: boolean;
      summary: { totalErrors: number; totalFiles: number };
      files: Array<{ passed: boolean; summary: { errorCount: number } }>;
      projectGraphSummary: { analyzedModuleCount: number };
      projectGraph?: unknown;
      crossFileHints: unknown[];
    };
    expect(parsed.passed).toBe(true);
    expect(parsed.summary.totalErrors).toBe(0);
    expect(parsed.summary.totalFiles).toBe(1);
    expect(parsed.files[0]?.summary.errorCount).toBe(0);
    expect(parsed.projectGraphSummary.analyzedModuleCount).toBeGreaterThanOrEqual(1);
    expect(parsed.projectGraph).toBeUndefined();
    expect(Array.isArray(parsed.crossFileHints)).toBe(true);
  });

  it('returns exitCode 1 and Markdown report for violation fixture', () => {
    const res = runCli([
      'node',
      'cli',
      'test/fixtures/violations/imperativeOrder.ts',
      '--format',
      'md',
    ]);
    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain('## [FAIL]');
    expect(res.stdout).toContain('### Blocking Errors');
    expect(res.stdout).toContain('## Project DAG & Cross-File Insights');
  });

  it('returns exitCode 2 when no files are provided', () => {
    const res = runCli(['node', 'cli']);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain('No input files provided');
  });
});
