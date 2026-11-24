import { constant, flow } from 'fp-ts/function';
import * as B from 'fp-ts/boolean';
import { match } from 'ts-pattern';

export type Event =
  | { readonly _tag: 'Click'; readonly count: number }
  | { readonly _tag: 'Reset' };

const isBig = (n: number) => n > 10;
const handleClick = (e: Extract<Event, { _tag: 'Click' }>) =>
  B.match(constant('small'), constant('big'))(isBig(e.count));
const handleReset = constant('reset');

const classifyEvent = (e: Event) =>
  match(e)
    .with({ _tag: 'Click' }, handleClick)
    .with({ _tag: 'Reset' }, handleReset)
    .exhaustive();

const toUpper = (s: string) => s.toUpperCase();

export const formatEvent = flow(
  classifyEvent,
  toUpper,
) satisfies (e: Event) => string;
