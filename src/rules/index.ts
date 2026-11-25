import * as Eq from 'fp-ts/lib/Eq.js';
import { flow } from 'fp-ts/lib/function.js';
import * as N from 'fp-ts/lib/number.js';
import * as RA from 'fp-ts/lib/ReadonlyArray.js';
import * as S from 'fp-ts/lib/string.js';
import { Lens } from 'monocle-ts';
import type { DiagnosticError, RuleContext } from '../model/report.js';
import { checkStructureRules } from './structureRules.js';
import { checkCompositionRules } from './compositionRules.js';
import { checkPointFreeRules } from './pointFreeRules.js';
import { checkDeclarativePurityRules } from './declarativePurityRules.js';
import { checkBranchingRules } from './branchingRules.js';
import { checkTypeSafetyAndMonadRules } from './typeSafetyAndMonadRules.js';

export type RuleRunner = (ctx: RuleContext) => ReadonlyArray<DiagnosticError>;

const applyRunner = (ctx: RuleContext) => (runner: RuleRunner) => runner(ctx);

const executeRunners = (ctx: RuleContext) =>
  RA.chain(applyRunner(ctx))([
    checkTypeSafetyAndMonadRules,
    checkStructureRules,
    checkCompositionRules,
    checkPointFreeRules,
    checkDeclarativePurityRules,
    checkBranchingRules,
  ]);

const errorLineLens = Lens.fromPath<DiagnosticError>()(['location', 'line']);
const errorColumnLens = Lens.fromPath<DiagnosticError>()(['location', 'column']);

const toErrorKey = (e: DiagnosticError) => ({
  ruleId: e.ruleId,
  line: errorLineLens.get(e),
  column: errorColumnLens.get(e),
  message: e.message,
});

const diagnosticErrorEq = Eq.contramap(toErrorKey)(
  Eq.struct({
    ruleId: S.Eq,
    line: N.Eq,
    column: N.Eq,
    message: S.Eq,
  }),
);

const dedupeErrors = RA.uniq(diagnosticErrorEq);

export const runAllRules = flow(
  executeRunners,
  dedupeErrors,
) satisfies RuleRunner;
