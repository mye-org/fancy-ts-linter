import { constant, flow } from 'fp-ts/function';
import * as O from 'fp-ts/Option';
import * as RTE from 'fp-ts/ReaderTaskEither';
import * as TE from 'fp-ts/TaskEither';

export type Account = {
  readonly id: string;
  readonly balanceCents: number;
};

export type AccountDeps = {
  readonly loadRawAccount: (id: string) => Promise<Account | null>;
};

export type AccountError = { readonly _tag: 'FetchFailed' } | { readonly _tag: 'NotFound' };
export type FetchAccountSummary = (id: string) => RTE.ReaderTaskEither<AccountDeps, AccountError, number>;

const toFetchError = (_: unknown): AccountError => ({ _tag: 'FetchFailed' });
const toNotFoundError = constant<AccountError>({ _tag: 'NotFound' });

const callRepo = (id: string) => (deps: AccountDeps) =>
  TE.tryCatch(constant(deps.loadRawAccount(id)), toFetchError);

const optionToEither = flow(
  O.fromNullable<Account | null>,
  RTE.fromOption(toNotFoundError),
);

const readBalance = (acc: Account) => acc.balanceCents;

export const fetchAccountSummary = flow(
  callRepo,
  RTE.chainW(optionToEither),
  RTE.map(readBalance),
) satisfies FetchAccountSummary;
