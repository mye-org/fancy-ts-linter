import { flow } from 'fp-ts/function';
import * as E from 'fp-ts/Either';

export type CheckFn = (n: number) => number;

const inc = (n: number) => n + 1;

const badBlock = (n: number) => {
  let x = n;
  if (x > 0) {
    return x;
  }
  return x + 1;
};

const complexLambda = (ns: ReadonlyArray<number>) =>
  ns.map((n) => inc(inc(n)));

const etaPlain = (n: number) => inc(n);
const etaNamespace = (n: number) => E.right(n);

export const main = flow(badBlock) satisfies CheckFn;
export { complexLambda, etaPlain, etaNamespace };
