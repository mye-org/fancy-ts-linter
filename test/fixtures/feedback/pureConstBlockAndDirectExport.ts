import * as M from 'fp-ts/Monoid';
import * as N from 'fp-ts/number';
import * as RA from 'fp-ts/ReadonlyArray';
import { match } from 'ts-pattern';

export type LineItem = {
  readonly name: string;
  readonly price: number;
  readonly active: boolean;
};

export type OrderSummaryInput = {
  readonly items: ReadonlyArray<LineItem>;
  readonly formatter: { readonly format: (n: number) => string };
  readonly fallback: string;
};

export type SummarizeOrder = (input: OrderSummaryInput) => string;

const sumNumbers = M.concatAll(N.MonoidSum);

const computeTotal = (input: OrderSummaryInput): string => {
  const activeItems = RA.filter((item: LineItem) => item.active && item.price > 0)(input.items);
  const prices = RA.map((item: LineItem) => item.price)(activeItems);
  const total = sumNumbers(prices);
  return match(total > 0)
    .with(true, () => input.formatter.format(total))
    .otherwise(() => input.fallback);
};

export const summarizeOrder = computeTotal satisfies SummarizeOrder;
