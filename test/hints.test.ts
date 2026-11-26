import * as E from 'fp-ts/Either';
import * as O from 'fp-ts/Option';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeFiles, type AnalyzeOptions } from '../src/index.js';

const defaultOpts: AnalyzeOptions = {
  tsconfigPath: O.some(path.resolve('tsconfig.json')),
  maxFlowSteps: 10,
  format: 'json',
  includeGraph: O.none,
  minPatternOccurrences: O.none,
  minDirModules: O.none,
  excludePatterns: O.none,
};

const analyzeOne = (relPath: string) => {
  const res = analyzeFiles({
    filePaths: [path.resolve(relPath)],
    options: defaultOpts,
  });
  if (E.isLeft(res)) {
    throw new Error(`Unexpected Left: ${res.left}`);
  }
  return res.right.files[0]!;
};

describe('Tier 2 AI Hint Detectors & Type-Flow Graph', () => {
  it('emits adt-over-flags and newtype-brand hints on flagExplosion.ts', () => {
    const report = analyzeOne('test/fixtures/violations/flagExplosion.ts');
    const categories = new Set(report.hints.map((h) => h.category));
    expect(categories.has('adt-over-flags')).toBe(true);
    expect(categories.has('newtype-brand')).toBe(true);
  });

  it('emits pattern-matching-depth hint on shallowSwitchMatch.ts', () => {
    const report = analyzeOne('test/fixtures/violations/shallowSwitchMatch.ts');
    const categories = new Set(report.hints.map((h) => h.category));
    expect(categories.has('pattern-matching-depth')).toBe(true);
  });

  it('emits ddd-decomposition hint when flow exceeds maxFlowSteps', () => {
    const res = analyzeFiles({
      filePaths: [path.resolve('test/fixtures/violations/longFlow12Steps.ts')],
      options: { ...defaultOpts, maxFlowSteps: 6 },
    });
    if (E.isLeft(res)) {
      throw new Error(res.left);
    }
    const report = res.right.files[0]!;
    expect(report.passed).toBe(true);
    const dddHints = report.hints.filter((h) => h.category === 'ddd-decomposition');
    expect(dddHints.length).toBeGreaterThanOrEqual(1);
    expect(dddHints[0]?.evidence).toContain('8 steps');
  });

  it('emits inference-hygiene hint for redundant private return type annotations', () => {
    const report = analyzeOne('test/fixtures/violations/redundantAnnotations.ts');
    expect(report.passed).toBe(true);
    const infHints = report.hints.filter((h) => h.category === 'inference-hygiene');
    expect(infHints.length).toBe(2);
  });

  it('builds accurate Type-Flow Graph nodes and edges for canonical priceOrder.ts', () => {
    const report = analyzeOne('test/fixtures/canonical/priceOrder.ts');
    const exportedNode = report.typeFlowGraph.nodes.find((n) => n.name === 'priceOrder');
    expect(exportedNode?.kind).toBe('exported-flow');
    expect(exportedNode?.effects).toContain('Either');
    expect(O.isSome(exportedNode?.stepCount ?? O.none)).toBe(true);
    expect(
      report.typeFlowGraph.edges.some(
        (e) => e.from === 'priceOrder' && e.to === 'normalizeOrder' && e.role === 'flow-step',
      ),
    ).toBe(true);
  });

  it('emits arity-strategy hints on deep curried chains in deepCurry.ts', () => {
    const report = analyzeOne('test/fixtures/violations/deepCurry.ts');
    const arityHints = report.hints.filter((h) => h.category === 'arity-strategy');
    expect(arityHints.length).toBe(2);
    expect(arityHints.some((h) => h.evidence.includes('4 nested parameter levels'))).toBe(true);
    expect(arityHints.some((h) => h.evidence.includes('3 nested parameter levels'))).toBe(true);
  });

  it('scopes optic hints to shared accessors and exempts curried/generic/HKT helpers from inference-hygiene', () => {
    const report = analyzeOne('test/fixtures/feedback/opticsAndInference.ts');
    const infHints = report.hints.filter((h) => h.category === 'inference-hygiene');
    expect(infHints.length).toBe(1);
    expect(infHints[0]?.hintId).toBe('inference-hygiene-simpleRedundant');

    const opticHints = report.hints.filter((h) => h.category === 'optic');
    expect(opticHints.length).toBe(1);
    expect(opticHints[0]?.hintId).toBe('optic-shared-accessor');
    expect(opticHints[0]?.evidence).toContain('user.contact');

    const oneOffReport = analyzeOne('test/fixtures/feedback/pureConstBlockAndDirectExport.ts');
    expect(oneOffReport.hints.filter((h) => h.category === 'optic')).toEqual([]);
  });
});
