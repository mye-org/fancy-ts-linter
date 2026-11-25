import { flow } from 'fp-ts/function';

export type ComputeInput = {
  readonly base: number;
  readonly taxRate: number;
};

export type RunCompute = (input: ComputeInput) => number;

const tooDeepCurry =
  (a: number) =>
  (b: number) =>
  (c: number) =>
  (d: number): number =>
    a + b + c + d;

const threeLevelCurry =
  (a: number) =>
  (b: number) =>
  (c: number): number =>
    a + b + c;

const stepOne = (input: ComputeInput): number =>
  tooDeepCurry(input.base)(1)(2)(3) + threeLevelCurry(input.base)(1)(2);

const stepTwo = (n: number): number => n * 2;

export const runCompute = flow(stepOne, stepTwo) satisfies RunCompute;
