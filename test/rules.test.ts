import * as E from 'fp-ts/Either';
import * as O from 'fp-ts/Option';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeFiles, type AnalyzeOptions } from '../src/index.js';

const defaultOpts: AnalyzeOptions = {
  tsconfigPath: O.some(path.resolve('tsconfig.json')),
  maxFlowSteps: 10,
  format: 'json',
};

const analyzeOne = (relPath: string) => {
  const res = analyzeFiles({
    filePaths: [path.resolve(relPath)],
    options: defaultOpts,
  });
  if (E.isLeft(res)) {
    throw new Error(`Unexpected Left: ${res.left}`);
  }
  const report = res.right.files[0];
  if (report === undefined) {
    throw new Error('Expected 1 report');
  }
  return report;
};

describe('Tier 1 Hard-Error Rules', () => {
  it.each([
    'test/fixtures/canonical/priceOrder.ts',
    'test/fixtures/canonical/updateUserProfile.ts',
    'test/fixtures/canonical/fetchAccountSummary.ts',
    'test/fixtures/canonical/evaluateOrderMatrix.ts',
    'test/fixtures/violations/longFlow12Steps.ts',
    'test/fixtures/violations/redundantAnnotations.ts',
  ])('passes canonical fixture %s with 0 hard errors', (fixture) => {
    const report = analyzeOne(fixture);
    expect(report.errors).toEqual([]);
    expect(report.passed).toBe(true);
    expect(O.isSome(report.summary.exportedFunction)).toBe(true);
  });

  it('flags all major imperative/structural/FP violations in imperativeOrder.ts', () => {
    const report = analyzeOne('test/fixtures/violations/imperativeOrder.ts');
    expect(report.passed).toBe(false);
    const ruleIds = new Set(report.errors.map((e) => e.ruleId));
    expect(ruleIds.has('single-exported-function')).toBe(true);
    expect(ruleIds.has('no-disallowed-top-level')).toBe(true);
    expect(ruleIds.has('no-imperative-constructs')).toBe(true);
    expect(ruleIds.has('no-mutating-methods')).toBe(true);
    expect(ruleIds.has('no-nullish-operators')).toBe(true);
    expect(ruleIds.has('no-ternary')).toBe(true);
    expect(ruleIds.has('no-type-holes')).toBe(true);
    expect(ruleIds.has('no-nested-spread')).toBe(true);
    expect(ruleIds.has('no-pipe')).toBe(true);
    expect(ruleIds.has('no-nested-flow')).toBe(true);
    expect(ruleIds.has('no-eta-reducible')).toBe(true);
    expect(ruleIds.has('unary-arity-only')).toBe(true);
    expect(ruleIds.has('no-nullable-types')).toBe(true);
  });

  it('flags curried chains deeper than 3 levels with max-curry-depth in deepCurry.ts', () => {
    const report = analyzeOne('test/fixtures/violations/deepCurry.ts');
    expect(report.passed).toBe(false);
    const curryErrors = report.errors.filter((e) => e.ruleId === 'max-curry-depth');
    expect(curryErrors.length).toBe(1);
    expect(curryErrors[0]?.message).toContain('depth 4');
  });

  it('passes pure const-binding blocks, direct function export, trivial lambdas, lazy thunks, and method wrappers', () => {
    const report = analyzeOne('test/fixtures/feedback/pureConstBlockAndDirectExport.ts');
    expect(report.errors).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.summary.exportedFunction).toEqual(O.some('summarizeOrder'));
  });

  it('flags imperative blocks, complex inline lambdas, plain/namespace eta wrappers, and trivial flow', () => {
    const report = analyzeOne('test/fixtures/feedback/imperativeBlockViolations.ts');
    expect(report.passed).toBe(false);
    const ruleIds = new Set(report.errors.map((e) => e.ruleId));
    expect(ruleIds.has('no-block-body')).toBe(true);
    expect(ruleIds.has('no-imperative-constructs')).toBe(true);
    expect(ruleIds.has('no-inline-lambda')).toBe(true);
    expect(ruleIds.has('no-eta-reducible')).toBe(true);
    expect(ruleIds.has('no-trivial-flow')).toBe(true);
    const etaErrors = report.errors.filter((e) => e.ruleId === 'no-eta-reducible');
    expect(etaErrors.length).toBe(2);
  });
});
