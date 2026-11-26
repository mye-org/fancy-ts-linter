import * as E from 'fp-ts/Either';
import * as O from 'fp-ts/Option';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import { analyzeFiles } from '../src/index.js';

const writeProjectFiles = (baseDir: string, files: Record<string, string>): void => {
  for (const [relPath, content] of Object.entries(files)) {
    const abs = path.join(baseDir, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
};

const baseTsConfig = JSON.stringify(
  {
    compilerOptions: {
      target: 'ES2023',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      skipLibCheck: true,
      noEmit: true,
    },
    include: ['src/**/*.ts'],
  },
  null,
  2,
);

describe('Cross-File DAG Architectural & Junk-Drawer Detectors', () => {
  let tmpRoot: string;

  beforeAll(() => {
    // Place temp fixture inside repo root so NodeNext resolves fp-ts from repo node_modules
    tmpRoot = fs.mkdtempSync(path.join(process.cwd(), '.tmp-dag-test-'));
  });

  afterAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('detects a name-agnostic junk-drawer directory ("kit/") while ignoring a pure homogeneous primitive library ("strings/")', () => {
    const projDir = path.join(tmpRoot, 'junk-drawer-proj');
    writeProjectFiles(projDir, {
      'tsconfig.json': baseTsConfig,
      'src/kit/hashSecret.ts': `
import * as crypto from 'node:crypto';
export type HashSecret = (raw: string) => string;
export const hashSecret = ((raw: string) => crypto.createHash('sha256').update(raw).digest('hex')) satisfies HashSecret;
`,
      'src/kit/joinBasePath.ts': `
import * as path from 'node:path';
export type JoinBasePath = (segment: string) => string;
export const joinBasePath = ((segment: string) => path.join('/var/app', segment)) satisfies JoinBasePath;
`,
      'src/kit/parseEndpoint.ts': `
import * as url from 'node:url';
export type ParseEndpoint = (raw: string) => string;
export const parseEndpoint = ((raw: string) => new url.URL(raw).hostname) satisfies ParseEndpoint;
`,
      'src/auth/login.ts': `
import { hashSecret } from '../kit/hashSecret.js';
export type Login = (secret: string) => string;
export const login = ((secret: string) => hashSecret(secret)) satisfies Login;
`,
      'src/infra/resolveFile.ts': `
import { joinBasePath } from '../kit/joinBasePath.js';
export type ResolveFile = (name: string) => string;
export const resolveFile = ((name: string) => joinBasePath(name)) satisfies ResolveFile;
`,
      'src/net/hostOf.ts': `
import { parseEndpoint } from '../kit/parseEndpoint.js';
export type HostOf = (endpoint: string) => string;
export const hostOf = ((endpoint: string) => parseEndpoint(endpoint)) satisfies HostOf;
`,
      // Negative control: pure homogeneous string primitive library
      'src/strings/trimText.ts': `
export type TrimText = (s: string) => string;
export const trimText = ((s: string) => s.trim()) satisfies TrimText;
`,
      'src/strings/upperText.ts': `
export type UpperText = (s: string) => string;
export const upperText = ((s: string) => s.toUpperCase()) satisfies UpperText;
`,
      'src/strings/lowerText.ts': `
export type LowerText = (s: string) => string;
export const lowerText = ((s: string) => s.toLowerCase()) satisfies LowerText;
`,
    });

    const res = analyzeFiles({
      filePaths: [path.join(projDir, 'src')],
      options: {
        tsconfigPath: O.some(path.join(projDir, 'tsconfig.json')),
        maxFlowSteps: 10,
        format: 'json',
        includeGraph: O.none,
        minPatternOccurrences: O.none,
        minDirModules: O.none,
        excludePatterns: O.none,
      },
    });

    expect(E.isRight(res)).toBe(true);
    if (E.isLeft(res)) return;

    const junkHints = res.right.crossFileHints.filter((h) => h.category === 'junk-drawer-directory');
    expect(junkHints.some((h) => h.evidence.includes('"kit"'))).toBe(true);
    expect(junkHints.some((h) => h.evidence.includes('"strings"'))).toBe(false);

    // Also verify single-file invocation inherits ambient project DAG context!
    const singleFileRes = analyzeFiles({
      filePaths: [path.join(projDir, 'src/kit/hashSecret.ts')],
      options: {
        tsconfigPath: O.some(path.join(projDir, 'tsconfig.json')),
        maxFlowSteps: 10,
        format: 'json',
        includeGraph: O.none,
        minPatternOccurrences: O.none,
        minDirModules: O.none,
        excludePatterns: O.none,
      },
    });
    expect(E.isRight(singleFileRes)).toBe(true);
    if (E.isRight(singleFileRes)) {
      expect(singleFileRes.right.summary.totalFiles).toBe(1);
      expect(singleFileRes.right.projectGraphSummary.analyzedModuleCount).toBe(9);
      expect(
        singleFileRes.right.crossFileHints.some(
          (h) => h.category === 'junk-drawer-directory' && h.evidence.includes('"kit"'),
        ),
      ).toBe(true);
    }
  });

  it('detects misplaced single-caller and narrow-subtree LCA modules without flagging top-down orchestrators', () => {
    const projDir = path.join(tmpRoot, 'misplaced-scope-proj');
    writeProjectFiles(projDir, {
      'tsconfig.json': baseTsConfig,
      'src/shared/calcPromo.ts': `
export type CalcPromo = (cents: number) => number;
export const calcPromo = ((cents: number) => Math.round(cents * 0.9)) satisfies CalcPromo;
`,
      'src/shared/validateZip.ts': `
export type ValidateZip = (zip: string) => boolean;
export const validateZip = ((zip: string) => zip.length === 5) satisfies ValidateZip;
`,
      'src/checkout/priceCart.ts': `
import { calcPromo } from '../shared/calcPromo.js';
export type PriceCart = (cents: number) => number;
export const priceCart = ((cents: number) => calcPromo(cents)) satisfies PriceCart;
`,
      'src/shipping/quote.ts': `
import { validateZip } from '../shared/validateZip.js';
export type Quote = (zip: string) => boolean;
export const quote = ((zip: string) => validateZip(zip)) satisfies Quote;
`,
      'src/shipping/label.ts': `
import { validateZip } from '../shared/validateZip.js';
export type Label = (zip: string) => boolean;
export const label = ((zip: string) => validateZip(zip)) satisfies Label;
`,
      // Root orchestrator calling checkout/priceCart should NOT trigger misplaced-scope for checkout/priceCart
      'src/app.ts': `
import { priceCart } from './checkout/priceCart.js';
export type RunApp = (cents: number) => number;
export const runApp = ((cents: number) => priceCart(cents)) satisfies RunApp;
`,
    });

    const res = analyzeFiles({
      filePaths: [path.join(projDir, 'src')],
      options: {
        tsconfigPath: O.some(path.join(projDir, 'tsconfig.json')),
        maxFlowSteps: 10,
        format: 'json',
        includeGraph: O.none,
        minPatternOccurrences: O.none,
        minDirModules: O.none,
        excludePatterns: O.none,
      },
    });

    expect(E.isRight(res)).toBe(true);
    if (E.isLeft(res)) return;

    const scopeHints = res.right.crossFileHints.filter((h) => h.category === 'misplaced-scope');
    expect(
      scopeHints.some(
        (h) => h.evidence.includes('shared/calcPromo.ts') && h.suggestion.includes('checkout/'),
      ),
    ).toBe(true);
    expect(
      scopeHints.some(
        (h) => h.evidence.includes('shared/validateZip.ts') && h.suggestion.includes('shipping/'),
      ),
    ).toBe(true);
    expect(
      scopeHints.some((h) => h.evidence.startsWith('Module "checkout/priceCart.ts"')),
    ).toBe(false);
  });

  it('detects dependency cycles (SCC) as Tier 2 hints without failing exit code', () => {
    const projDir = path.join(tmpRoot, 'cycle-proj');
    writeProjectFiles(projDir, {
      'tsconfig.json': baseTsConfig,
      'src/billing/stepA.ts': `
import { stepB } from './stepB.js';
export type StepA = (n: number) => number;
export const stepA = ((n: number) => (n > 0 ? stepB(n - 1) : 0)) satisfies StepA;
`,
      'src/billing/stepB.ts': `
import { stepA } from './stepA.js';
export type StepB = (n: number) => number;
export const stepB = ((n: number) => (n > 0 ? stepA(n - 1) : 1)) satisfies StepB;
`,
    });

    const res = analyzeFiles({
      filePaths: [path.join(projDir, 'src')],
      options: {
        tsconfigPath: O.some(path.join(projDir, 'tsconfig.json')),
        maxFlowSteps: 10,
        format: 'json',
        includeGraph: O.some(true),
        minPatternOccurrences: O.none,
        minDirModules: O.none,
        excludePatterns: O.none,
      },
    });

    expect(E.isRight(res)).toBe(true);
    if (E.isLeft(res)) return;

    expect(res.right.projectGraphSummary.cycleCount).toBe(1);
    expect(O.isSome(res.right.projectGraph)).toBe(true);
    if (O.isSome(res.right.projectGraph)) {
      expect(res.right.projectGraph.value.cycles.length).toBe(1);
    }
    const cycleHints = res.right.crossFileHints.filter((h) => h.category === 'dependency-cycle');
    expect(cycleHints.length).toBe(1);
    expect(cycleHints[0]?.priority).toBe('high');
    expect(cycleHints[0]?.evidence).toContain('stepA.ts');
    expect(cycleHints[0]?.evidence).toContain('stepB.ts');
  });

  it('detects hub / high-blast-radius bottlenecks and supports CLI directory + --include-graph', () => {
    const projDir = path.join(tmpRoot, 'hub-proj');
    writeProjectFiles(projDir, {
      'tsconfig.json': baseTsConfig,
      'src/hub/dispatch.ts': `
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import * as url from 'node:url';
export type Dispatch = (raw: string) => string;
export const dispatch = ((raw: string) => {
  const host = new url.URL(raw).hostname;
  const joined = path.join('/api', host);
  return crypto.createHash('sha256').update(joined).digest('hex');
}) satisfies Dispatch;
`,
      'src/a/runA.ts': `
import { dispatch } from '../hub/dispatch.js';
export type RunA = (raw: string) => string;
export const runA = dispatch satisfies RunA;
`,
      'src/b/runB.ts': `
import { dispatch } from '../hub/dispatch.js';
export type RunB = (raw: string) => string;
export const runB = dispatch satisfies RunB;
`,
      'src/c/runC.ts': `
import { dispatch } from '../hub/dispatch.js';
export type RunC = (raw: string) => string;
export const runC = dispatch satisfies RunC;
`,
    });

    const cliRes = runCli([
      'node',
      'cli',
      path.join(projDir, 'src'),
      '--tsconfig',
      path.join(projDir, 'tsconfig.json'),
      '--format',
      'json',
      '--include-graph',
    ]);

    expect(Number(cliRes.exitCode)).toBe(0);
    const parsed = JSON.parse(String(cliRes.stdout)) as {
      passed: boolean;
      projectGraph?: { nodes: unknown[]; edges: unknown[] };
      crossFileHints: Array<{ category: string; evidence: string }>;
    };
    expect(parsed.passed).toBe(true);
    expect(parsed.projectGraph).toBeDefined();
    expect(parsed.projectGraph?.nodes.length).toBe(4);
    expect(
      parsed.crossFileHints.some(
        (h) => h.category === 'hub-bottleneck' && h.evidence.includes('hub/dispatch.ts'),
      ),
    ).toBe(true);
  });
});
