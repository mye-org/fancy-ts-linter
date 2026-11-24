import { flow } from 'fp-ts/function';

export type Invoice = {
  readonly invoiceId: string;
  readonly customerEmail: string;
  readonly totalAmount: number;
  readonly status: string;
  readonly isPaid: boolean;
  readonly isCancelled: boolean;
  readonly isRefunded: boolean;
};

const applyDiscount = (applyPromo: boolean) => (inv: Invoice) =>
  applyPromo ? inv.totalAmount * 0.9 : inv.totalAmount;

const identityNum = (n: number) => n;

export const computeInvoice = flow(
  applyDiscount(true),
  identityNum,
) satisfies (inv: Invoice) => number;
