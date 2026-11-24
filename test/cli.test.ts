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
    const parsed = JSON.parse(res.stdout) as { passed: boolean; summary: { errorCount: number } };
    expect(parsed.passed).toBe(true);
    expect(parsed.summary.errorCount).toBe(0);
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
    expect(res.stdout).toContain('### Module Type-Flow Map');
  });

  it('returns exitCode 2 when no files are provided', () => {
    const res = runCli(['node', 'cli']);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain('No input files provided');
  });
});
