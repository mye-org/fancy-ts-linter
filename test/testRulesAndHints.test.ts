import * as E from 'fp-ts/Either';
import { afterAll, describe, expect, it } from 'vitest';
import {
  analyzeInTempDir,
  analyzeMissingFile,
  cleanupTempProjects,
  createTempProject,
} from './helpers/tempProject.js';

afterAll(cleanupTempProjects);

describe('Test-file Tier 1 Hygiene Rules & Tier 2 Quality/Smell Hints', () => {
  it('passes a clean unit test file covering all ADT variants with 0 errors and 0 hints', () => {
    const dir = createTempProject({
      'order.ts': `
        export type Order =
          | { readonly _tag: 'Draft'; readonly amount: number }
          | { readonly _tag: 'Confirmed'; readonly amount: number };

        export const describeOrder = (order: Order): string =>
          order._tag === 'Draft' ? 'draft' : 'confirmed';
      `,
      'order.test.ts': `
        import { describeOrder } from './order.js';

        declare function describe(name: string, fn: () => void): void;
        declare function it(name: string, fn: () => void): void;
        declare function expect(val: unknown): { toBe: (expected: unknown) => void };

        describe('describeOrder', () => {
          it('handles Draft orders', () => {
            const res = describeOrder({ _tag: 'Draft', amount: 10 });
            expect(res).toBe('draft');
          });

          it('handles Confirmed orders', () => {
            const res = describeOrder({ _tag: 'Confirmed', amount: 20 });
            expect(res).toBe('confirmed');
          });
        });
      `,
    });

    const report = analyzeInTempDir(dir, 'order.test.ts');
    expect(report.passed).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.hints).toEqual([]);
  });

  it('returns Left for missing file and Right for existing file', () => {
    const dir = createTempProject({
      'ok.ts': `export const id = (x: number): number => x;`,
    });
    expect(E.isLeft(analyzeMissingFile(dir, 'missing.test.ts'))).toBe(true);
    expect(E.isRight(analyzeMissingFile(dir, 'ok.ts'))).toBe(true);
  });

  it('flags Tier 1 test-no-type-holes and test-no-branching violations', () => {
    const dir = createTempProject({
      'math.ts': `export const addOne = (n: number): number => n + 1;`,
      'math.test.ts': `
        import { addOne } from './math.js';

        declare function describe(name: string, fn: () => void): void;
        declare function it(name: string, fn: () => void): void;
        declare function expect(val: unknown): { toBe: (expected: unknown) => void };

        describe('math', () => {
          it('has branching and type holes', () => {
            const input = (1 as any)!;
            if (input > 0) {
              expect(addOne(input)).toBe(2);
            }
          });
        });
      `,
    });

    const report = analyzeInTempDir(dir, 'math.test.ts');
    const ruleIds = new Set(report.errors.map((e) => String(e.ruleId)));
    expect(report.passed).toBe(false);
    expect(ruleIds.has('test-no-type-holes')).toBe(true);
    expect(ruleIds.has('test-no-branching')).toBe(true);
  });

  it('flags Tier 1 shared mutable state, nondeterminism, and assertionless tests without production FP rules', () => {
    const dir = createTempProject({
      'math.ts': `export const addOne = (n: number): number => n + 1;`,
      'math.test.ts': `
        import { addOne } from './math.js';

        declare function describe(name: string, fn: () => void): void;
        declare function it(name: string, fn: () => void): void;
        declare function expect(val: unknown): { toBe: (expected: unknown) => void };

        describe('math', () => {
          let sharedCounter = 0;

          it('is non-deterministic', () => {
            const now = Date.now();
            const d = new Date();
            const r = Math.random();
            expect(addOne(now + d.getTime() + r)).toBe(1);
          });

          it('has no assertions', () => {
            addOne(sharedCounter);
          });
        });
      `,
    });

    const report = analyzeInTempDir(dir, 'math.test.ts');
    const ruleIds = new Set(report.errors.map((e) => String(e.ruleId)));
    const expectedRules = [
      'test-no-shared-mutable-state',
      'test-no-nondeterminism',
      'test-no-assertionless-test',
    ];
    expect(expectedRules.every((id) => ruleIds.has(id))).toBe(true);
    expect(ruleIds.has('single-exported-function')).toBe(false);
  });

  it('emits Tier 2 hints for missing ADT variants and multiple behaviors', () => {
    const dir = createTempProject({
      'workflow.ts': `
        export type State =
          | { readonly _tag: 'Pending' }
          | { readonly _tag: 'Approved' }
          | { readonly _tag: 'Rejected' };

        export const transition = (s: State): string => s._tag;
      `,
      'workflow.test.ts': `
        import { transition } from './workflow.js';

        declare function describe(name: string, fn: () => void): void;
        declare function it(name: string, fn: () => void): void;
        declare function expect(val: unknown): { toBe: (expected: unknown) => void };

        describe('workflow', () => {
          it('covers Pending with excessive assertions', () => {
            expect(transition({ _tag: 'Pending' })).toBe('Pending');
            expect(transition({ _tag: 'Pending' })).toBe('Pending');
            expect(transition({ _tag: 'Pending' })).toBe('Pending');
            expect(transition({ _tag: 'Pending' })).toBe('Pending');
          });
        });
      `,
    });

    const report = analyzeInTempDir(dir, 'workflow.test.ts');
    const hintIds = report.hints.map((h) => String(h.hintId));
    expect(report.passed).toBe(true);
    expect(hintIds.some((id) => id.startsWith('test-missing-adt-variants-'))).toBe(true);
    expect(hintIds.some((id) => id.startsWith('test-multiple-behaviors-'))).toBe(true);
  });

  it('emits Tier 2 testability code-smell hints (mocking, bloated fixture, combinatorial explosion, async)', () => {
    const dir = createTempProject({
      'workflow.ts': `
        export const runStep = (input: unknown): string => String(input);
      `,
      'workflow.test.ts': `
        import { runStep } from './workflow.js';

        declare function describe(name: string, fn: () => void): void;
        declare function it(name: string, fn: () => void): void;
        declare function expect(val: unknown): { toBe: (expected: unknown) => void };
        declare const mockApi: {
          mock: (name: string) => void;
          spyOn: (obj: unknown, k: string) => void;
          fn: () => void;
          useFakeTimers: () => void;
        };

        describe('workflow', () => {
          it('case 1', () => {
            mockApi.mock('a');
            mockApi.spyOn({}, 'b');
            mockApi.fn();
            mockApi.useFakeTimers();
            const bloated = {
              a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: 8,
              nested: { level2: { level3: true } },
            };
            expect(runStep(bloated)).toBe('ok');
          });

          it('case 2', () => { expect(runStep(2)).toBe('2'); });
          it('case 3', () => { expect(runStep(3)).toBe('3'); });
          it('case 4', () => { expect(runStep(4)).toBe('4'); });
          it('case 5', () => { expect(runStep(5)).toBe('5'); });
          it('case 6', () => { expect(runStep(6)).toBe('6'); });
          it('case 7', () => { expect(runStep(7)).toBe('7'); });
          it('case 8', () => { expect(runStep(8)).toBe('8'); });
        });
      `,
    });

    const report = analyzeInTempDir(dir, 'workflow.test.ts');
    const hintIds = report.hints.map((h) => String(h.hintId));
    expect(hintIds).toContain('test-smell-excessive-mocking');
    expect(hintIds).toContain('test-smell-async-ceremony');
    expect(
      hintIds.some((id) => id.startsWith('test-smell-bloated-fixture-')) &&
        hintIds.some((id) => id.startsWith('test-smell-combinatorial-explosion-')),
    ).toBe(true);
  });
});
