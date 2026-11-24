import { flow } from 'fp-ts/function';

export type DoubleAndInc = (n: number) => number;

const double = (n: number): number => n * 2;
const inc = (n: number): number => n + 1;

export const doubleAndInc = flow(
  double,
  inc,
) satisfies DoubleAndInc;
