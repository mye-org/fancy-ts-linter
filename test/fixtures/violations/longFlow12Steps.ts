import { flow } from 'fp-ts/function';

export type TransformNumber = (n: number) => number;

const add1 = (n: number) => n + 1;
const mul2 = (n: number) => n * 2;

export const eightStepTransform = flow(
  add1,
  mul2,
  add1,
  mul2,
  add1,
  mul2,
  add1,
  mul2,
) satisfies TransformNumber;
