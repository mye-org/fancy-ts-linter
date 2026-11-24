import { flow } from 'fp-ts/function';
import * as E from 'fp-ts/Either';
import { Newtype, iso } from 'newtype-ts';
import { match, P } from 'ts-pattern';

export type USD = Newtype<{ readonly USD: unique symbol }, number>;
export type PositiveUSD = Newtype<{ readonly PositiveUSD: unique symbol }, number>;
export type TaxRate = Newtype<{ readonly TaxRate: unique symbol }, number>;

export type Order =
  | { readonly _tag: 'Draft'; readonly subtotal: USD }
  | { readonly _tag: 'Taxable'; readonly subtotal: PositiveUSD; readonly taxRate: TaxRate }
  | { readonly _tag: 'TaxExempt'; readonly subtotal: PositiveUSD };

export type PricingError = { readonly _tag: 'NonPositiveSubtotal'; readonly raw: number };
export type PriceOrder = (order: Order) => E.Either<PricingError, PositiveUSD>;

const isoUSD = iso<USD>();
const isoPositiveUSD = iso<PositiveUSD>();
const isoTaxRate = iso<TaxRate>();

const isPositive = (n: number) => n > 0;
const isPositiveRate = flow(isoTaxRate.unwrap, isPositive);
const toNonPositiveError = (raw: number): PricingError => ({
  _tag: 'NonPositiveSubtotal',
  raw,
});
const roundCents = (n: number) => Math.round(n * 100) / 100;
const roundPositiveUSD = isoPositiveUSD.modify(roundCents);

const addTax = ({ subtotal, taxRate }: Extract<Order, { _tag: 'Taxable' }>) =>
  isoPositiveUSD.wrap(isoPositiveUSD.unwrap(subtotal) * (1 + isoTaxRate.unwrap(taxRate)));

const ensurePositive = flow(
  isoUSD.unwrap,
  E.fromPredicate(isPositive, toNonPositiveError),
  E.map(isoPositiveUSD.wrap),
);

const priceTaxable = flow(addTax, E.right);

const normalizeOrder = (order: Order) =>
  match(order)
    .with({ _tag: 'Draft', subtotal: P.select() }, ensurePositive)
    .with({ _tag: 'Taxable', taxRate: P.when(isPositiveRate) }, priceTaxable)
    .with({ _tag: 'Taxable', subtotal: P.select() }, E.right)
    .with({ _tag: 'TaxExempt', subtotal: P.select() }, E.right)
    .exhaustive();

export const priceOrder = flow(
  normalizeOrder,
  E.map(roundPositiveUSD),
) satisfies PriceOrder;
