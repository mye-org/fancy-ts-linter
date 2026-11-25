import * as E from 'fp-ts/Either';
import { flow } from 'fp-ts/function';

export type Profile = {
  readonly user: {
    readonly contact: {
      readonly email: string;
      readonly city: string;
    };
  };
};

export type FormatProfile = (p: Profile) => E.Either<string, string>;

const simpleRedundant = (n: number): number => n * 2;

const curriedHelper =
  (prefix: string) =>
  (value: string): string =>
    `${prefix}:${value}`;

const genericHelper = <T>(x: T): T => x;

const monadHelper = (email: string): E.Either<string, string> =>
  email.includes('@') ? E.right(email) : E.left('invalid');

const readCityOneOff = (p: Profile) => p.user.contact.city;

const formatEmailA = (p: Profile) => curriedHelper('a')(p.user.contact.email);
const formatEmailB = (p: Profile) => curriedHelper('b')(p.user.contact.email);

const combineProfile = (p: Profile) => {
  const _a = formatEmailA(p);
  const _b = formatEmailB(p);
  const _c = readCityOneOff(p);
  const _n = simpleRedundant(1);
  const _g = genericHelper(_c);
  return monadHelper(_a);
};

export const formatProfile = flow(combineProfile) satisfies FormatProfile;
