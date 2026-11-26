import * as E from 'fp-ts/Either';
import * as O from 'fp-ts/Option';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

describe('Cross-File Pattern & Abstraction Discovery', () => {
  let tmpRoot: string;

  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(process.cwd(), '.tmp-patterns-test-'));
  });

  afterAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('discovers missing domain models (repeated field clusters, reinvented ADTs, repeated raw primitives)', () => {
    const projDir = path.join(tmpRoot, 'domain-models-proj');
    writeProjectFiles(projDir, {
      'tsconfig.json': baseTsConfig,
      'src/orders/priceOrder.ts': `
export type OrderPrice = { readonly amountCents: number; readonly currencyCode: string; readonly orderId: string };
export type OrderLoadState =
  | { readonly _tag: 'Idle' }
  | { readonly _tag: 'Loading' }
  | { readonly _tag: 'Ready'; readonly total: number };
export type PriceOrder = (p: OrderPrice) => number;
export const priceOrder = ((p: OrderPrice) => p.amountCents) satisfies PriceOrder;
`,
      'src/invoices/totalInvoice.ts': `
export type InvoiceTotal = { readonly amountCents: number; readonly currencyCode: string; readonly invoiceId: string };
export type InvoiceLoadState =
  | { readonly _tag: 'Idle' }
  | { readonly _tag: 'Loading' }
  | { readonly _tag: 'Ready'; readonly due: number };
export type TotalInvoice = (i: InvoiceTotal) => number;
export const totalInvoice = ((i: InvoiceTotal) => i.amountCents) satisfies TotalInvoice;
`,
      'src/refunds/calcRefund.ts': `
export type RefundAmount = { readonly amountCents: number; readonly currencyCode: string; readonly refundId: string };
export type RefundLoadState =
  | { readonly _tag: 'Idle' }
  | { readonly _tag: 'Loading' }
  | { readonly _tag: 'Ready'; readonly refunded: number };
export type CalcRefund = (r: RefundAmount) => number;
export const calcRefund = ((r: RefundAmount) => r.amountCents) satisfies CalcRefund;
`,
    });

    const res = analyzeFiles({
      filePaths: [path.join(projDir, 'src')],
      options: {
        tsconfigPath: O.some(path.join(projDir, 'tsconfig.json')),
        maxFlowSteps: 10,
        format: 'json',
      },
    });

    expect(E.isRight(res)).toBe(true);
    if (E.isLeft(res)) return;

    const dmHints = res.right.crossFileHints.filter((h) => h.category === 'missing-domain-model');
    expect(dmHints.some((h) => h.hintId.startsWith('missing-domain-model-fields'))).toBe(true);
    expect(dmHints.some((h) => h.hintId.startsWith('missing-domain-model-adt'))).toBe(true);
    expect(
      dmHints.some(
        (h) => h.hintId === 'missing-domain-model-newtype-currencyCode',
      ),
    ).toBe(true);
  });

  it('discovers repeated flow(...) pipeline motifs across files', () => {
    const projDir = path.join(tmpRoot, 'pipeline-motif-proj');
    writeProjectFiles(projDir, {
      'tsconfig.json': baseTsConfig,
      'src/a/parseA.ts': `
import { flow } from 'fp-ts/function';
import * as E from 'fp-ts/Either';
const isPos = (n: number) => n > 0;
const err = (_: number) => 'bad';
const checkEven = (n: number) => (n % 2 === 0 ? E.right(n) : E.left('odd'));
const dbl = (n: number) => n * 2;
export type ParseA = (n: number) => E.Either<string, number>;
export const parseA = flow(E.fromPredicate(isPos, err), E.chain(checkEven), E.map(dbl)) satisfies ParseA;
`,
      'src/b/parseB.ts': `
import { flow } from 'fp-ts/function';
import * as E from 'fp-ts/Either';
const isNonEmpty = (s: string) => s.length > 0;
const err = (_: string) => 'empty';
const checkLen = (s: string) => (s.length < 10 ? E.right(s) : E.left('long'));
const up = (s: string) => s.toUpperCase();
export type ParseB = (s: string) => E.Either<string, string>;
export const parseB = flow(E.fromPredicate(isNonEmpty, err), E.chain(checkLen), E.map(up)) satisfies ParseB;
`,
      'src/c/parseC.ts': `
import { flow } from 'fp-ts/function';
import * as E from 'fp-ts/Either';
const isAdult = (n: number) => n >= 18;
const err = (_: number) => 'minor';
const checkCap = (n: number) => (n <= 120 ? E.right(n) : E.left('cap'));
const inc = (n: number) => n + 1;
export type ParseC = (n: number) => E.Either<string, number>;
export const parseC = flow(E.fromPredicate(isAdult, err), E.chain(checkCap), E.map(inc)) satisfies ParseC;
`,
    });

    const res = analyzeFiles({
      filePaths: [path.join(projDir, 'src')],
      options: {
        tsconfigPath: O.some(path.join(projDir, 'tsconfig.json')),
        maxFlowSteps: 10,
        format: 'json',
      },
    });

    expect(E.isRight(res)).toBe(true);
    if (E.isLeft(res)) return;

    const motifs = res.right.crossFileHints.filter((h) => h.category === 'pipeline-motif');
    expect(motifs.length).toBeGreaterThanOrEqual(1);
    expect(motifs[0]?.evidence).toContain('E.fromPredicate -> E.chain -> E.map');
  });

  it('discovers generic parametric data types and FP typeclass opportunities (Semigroup/Monoid)', () => {
    const projDir = path.join(tmpRoot, 'generics-typeclasses-proj');
    writeProjectFiles(projDir, {
      'tsconfig.json': baseTsConfig,
      'src/orders/orderPage.ts': `
import * as O from 'fp-ts/Option';
export type Order = { readonly orderId: string; readonly total: number };
export type OrderPage = {
  readonly items: ReadonlyArray<Order>;
  readonly total: number;
  readonly nextCursor: O.Option<string>;
};
export type MergeOrder = (a: Order) => (b: Order) => Order;
export const mergeOrder = ((a: Order) => (b: Order) => ({ orderId: a.orderId, total: a.total + b.total })) satisfies MergeOrder;
`,
      'src/users/userPage.ts': `
import * as O from 'fp-ts/Option';
export type User = { readonly userId: string; readonly score: number };
export type UserPage = {
  readonly items: ReadonlyArray<User>;
  readonly total: number;
  readonly nextCursor: O.Option<string>;
};
export type MergeUser = (a: User) => (b: User) => User;
export const mergeUser = ((a: User) => (b: User) => ({ userId: a.userId, score: a.score + b.score })) satisfies MergeUser;
`,
      'src/invoices/invoicePage.ts': `
import * as O from 'fp-ts/Option';
export type Invoice = { readonly invoiceId: string; readonly balance: number };
export type InvoicePage = {
  readonly items: ReadonlyArray<Invoice>;
  readonly total: number;
  readonly nextCursor: O.Option<string>;
};
export type MergeInvoice = (a: Invoice) => (b: Invoice) => Invoice;
export const mergeInvoice = ((a: Invoice) => (b: Invoice) => ({ invoiceId: a.invoiceId, balance: a.balance + b.balance })) satisfies MergeInvoice;
`,
    });

    const res = analyzeFiles({
      filePaths: [path.join(projDir, 'src')],
      options: {
        tsconfigPath: O.some(path.join(projDir, 'tsconfig.json')),
        maxFlowSteps: 10,
        format: 'json',
      },
    });

    expect(E.isRight(res)).toBe(true);
    if (E.isLeft(res)) return;

    const genericHints = res.right.crossFileHints.filter(
      (h) => h.category === 'generic-abstraction',
    );
    expect(genericHints.some((h) => h.hintId.startsWith('generic-datatype-'))).toBe(true);
    expect(
      genericHints.some((h) => h.hintId === 'generic-typeclass-semigroup-monoid'),
    ).toBe(true);
  });

  it('discovers cross-file environment threading along a call DAG path', () => {
    const projDir = path.join(tmpRoot, 'env-threading-proj');
    writeProjectFiles(projDir, {
      'tsconfig.json': baseTsConfig,
      'src/types.ts': `
export type AppEnv = { readonly apiUrl: string; readonly apiKey: string };
`,
      'src/repo/fetchRecord.ts': `
import * as TE from 'fp-ts/TaskEither';
import type { AppEnv } from '../types.js';
export type FetchRecord = (env: AppEnv) => (id: string) => TE.TaskEither<string, string>;
export const fetchRecord = ((env: AppEnv) => (id: string) => TE.right(env.apiUrl + '/' + id)) satisfies FetchRecord;
`,
      'src/service/loadAccount.ts': `
import * as TE from 'fp-ts/TaskEither';
import type { AppEnv } from '../types.js';
import { fetchRecord } from '../repo/fetchRecord.js';
export type LoadAccount = (env: AppEnv) => (id: string) => TE.TaskEither<string, string>;
export const loadAccount = ((env: AppEnv) => (id: string) => fetchRecord(env)(id)) satisfies LoadAccount;
`,
      'src/api/handleAccount.ts': `
import * as TE from 'fp-ts/TaskEither';
import type { AppEnv } from '../types.js';
import { loadAccount } from '../service/loadAccount.js';
export type HandleAccount = (env: AppEnv) => (id: string) => TE.TaskEither<string, string>;
export const handleAccount = ((env: AppEnv) => (id: string) => loadAccount(env)(id)) satisfies HandleAccount;
`,
    });

    const res = analyzeFiles({
      filePaths: [path.join(projDir, 'src')],
      options: {
        tsconfigPath: O.some(path.join(projDir, 'tsconfig.json')),
        maxFlowSteps: 10,
        format: 'json',
      },
    });

    expect(E.isRight(res)).toBe(true);
    if (E.isLeft(res)) return;

    const envHints = res.right.crossFileHints.filter((h) => h.category === 'environment-threading');
    expect(envHints.length).toBeGreaterThanOrEqual(1);
    expect(envHints[0]?.evidence).toContain('AppEnv');
    expect(envHints[0]?.suggestion).toContain('ReaderTaskEither');
  });

  it('discovers architectural DAG motifs (Strategy pattern, pure-to-IO layer leakage, and shared cross-file Optics)', () => {
    const projDir = path.join(tmpRoot, 'arch-motifs-proj');
    writeProjectFiles(projDir, {
      'tsconfig.json': baseTsConfig,
      'src/domain.ts': `
export type BillingAddress = { readonly zip: string; readonly city: string };
export type Customer = { readonly billing: BillingAddress };
export type Order = { readonly customer: Customer; readonly cents: number };
export type Receipt = { readonly code: string };
`,
      // 3 parallel strategy implementations + shared nested optic path order.customer.billing.zip
      'src/payments/card.ts': `
import * as E from 'fp-ts/Either';
import type { Order, Receipt } from '../domain.js';
export type PayCard = (order: Order) => E.Either<string, Receipt>;
export const payCard = ((order: Order) => E.right({ code: 'CARD-' + order.customer.billing.zip })) satisfies PayCard;
`,
      'src/payments/paypal.ts': `
import * as E from 'fp-ts/Either';
import type { Order, Receipt } from '../domain.js';
export type PayPaypal = (order: Order) => E.Either<string, Receipt>;
export const payPaypal = ((order: Order) => E.right({ code: 'PP-' + order.customer.billing.zip })) satisfies PayPaypal;
`,
      'src/payments/wire.ts': `
import * as E from 'fp-ts/Either';
import type { Order, Receipt } from '../domain.js';
export type PayWire = (order: Order) => E.Either<string, Receipt>;
export const payWire = ((order: Order) => E.right({ code: 'WIRE-' + order.customer.billing.zip })) satisfies PayWire;
`,
      // Effect leakage: pure module importing TaskEither module
      'src/io/fetchFx.ts': `
import * as TE from 'fp-ts/TaskEither';
export type FetchFx = (code: string) => TE.TaskEither<string, number>;
export const fetchFx = ((_code: string) => TE.right(1.1)) satisfies FetchFx;
`,
      'src/core/calcRate.ts': `
import { fetchFx } from '../io/fetchFx.js';
export type CalcRate = (code: string) => string;
export const calcRate = ((code: string) => (fetchFx(code) ? code : code)) satisfies CalcRate;
`,
    });

    const res = analyzeFiles({
      filePaths: [path.join(projDir, 'src')],
      options: {
        tsconfigPath: O.some(path.join(projDir, 'tsconfig.json')),
        maxFlowSteps: 10,
        format: 'json',
      },
    });

    expect(E.isRight(res)).toBe(true);
    if (E.isLeft(res)) return;

    const archHints = res.right.crossFileHints.filter((h) => h.category === 'architectural-motif');
    expect(archHints.some((h) => h.hintId.startsWith('architectural-motif-strategy-'))).toBe(true);
    expect(archHints.some((h) => h.hintId.startsWith('architectural-motif-shared-optic-'))).toBe(true);
    expect(archHints.some((h) => h.hintId.startsWith('architectural-motif-effect-leak-'))).toBe(true);
  });
});
