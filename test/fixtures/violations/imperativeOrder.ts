import { flow, pipe } from 'fp-ts/function';

export type OrderInput = {
  readonly id: string;
  readonly amount?: number | null;
  readonly nested: {
    readonly tag: string;
  };
};

export const helperExtra = (x: number) => x + 1;

export async function processOrder(input: OrderInput, flag: boolean): Promise<number> {
  let total = input.amount ?? 0;
  if (flag) {
    total = total + 10;
  }
  const tag = input.nested?.tag!;
  const casted = tag as string;
  const arr = [1, 2];
  arr.push(3);
  const updated = { ...input, nested: { ...input.nested, tag: casted } };
  const eta = (n: number) => helperExtra(n);
  const piped = pipe(total, eta);
  const nestedFlow = flow(helperExtra, flow(helperExtra, helperExtra));
  return total > 0 ? nestedFlow(piped) : 0;
}
