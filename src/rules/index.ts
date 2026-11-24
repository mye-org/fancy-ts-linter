import { flow } from 'fp-ts/lib/function.js';
import * as RA from 'fp-ts/lib/ReadonlyArray.js';
import type { DiagnosticError, RuleContext } from '../model/report.js';
import { checkStructureRules } from './structureRules.js';
import { checkCompositionRules } from './compositionRules.js';
import { checkPointFreeRules } from './pointFreeRules.js';
import { checkDeclarativePurityRules } from './declarativePurityRules.js';
import { checkBranchingRules } from './branchingRules.js';
import { checkTypeSafetyAndMonadRules } from './typeSafetyAndMonadRules.js';

export type RuleRunner = (ctx: RuleContext) => ReadonlyArray<DiagnosticError>;

const runners: ReadonlyArray<RuleRunner> = [
  checkTypeSafetyAndMonadRules,
  checkStructureRules,
  checkCompositionRules,
  checkPointFreeRules,
  checkDeclarativePurityRules,
  checkBranchingRules,
];

const executeRunners = (ctx: RuleContext): ReadonlyArray<DiagnosticError> =>
  RA.chain((runner: RuleRunner) => runner(ctx))(runners);

const dedupeErrors = (errors: ReadonlyArray<DiagnosticError>): ReadonlyArray<DiagnosticError> =>
  RA.uniq({
    equals: (a: DiagnosticError, b: DiagnosticError) =>
      a.ruleId === b.ruleId &&
      a.location.line === b.location.line &&
      a.location.column === b.location.column &&
      a.message === b.message,
  })(errors);

export const runAllRules = flow(
  executeRunners,
  dedupeErrors,
) satisfies RuleRunner;
