import { constant, flow } from 'fp-ts/function';
import { match } from 'ts-pattern';

export type Tier = 'Free' | 'Pro';
export type BillingState = 'Active' | 'PastDue';
export type AccessDecision = 'Allow' | 'Warn' | 'Block';

export type AccessRequest = readonly [BillingState, Tier];
export type EvaluateAccess = (req: AccessRequest) => AccessDecision;

const allow = constant<AccessDecision>('Allow');
const warn = constant<AccessDecision>('Warn');
const block = constant<AccessDecision>('Block');

const decideByMatrix = (req: AccessRequest) =>
  match(req)
    .with(['Active', 'Free'], allow)
    .with(['Active', 'Pro'], allow)
    .with(['PastDue', 'Pro'], warn)
    .with(['PastDue', 'Free'], block)
    .exhaustive();

const identityDecision = (d: AccessDecision) => d;

export const evaluateAccess = flow(
  decideByMatrix,
  identityDecision,
) satisfies EvaluateAccess;
