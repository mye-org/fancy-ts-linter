import * as Eq from 'fp-ts/lib/Eq.js';
import { flow } from 'fp-ts/lib/function.js';
import * as N from 'fp-ts/lib/number.js';
import * as RA from 'fp-ts/lib/ReadonlyArray.js';
import * as S from 'fp-ts/lib/string.js';
import { iso } from 'newtype-ts';
import type {
  ColumnNumber,
  DiagnosticError,
  DiagnosticMessage,
  LineNumber,
  RuleContext,
  RuleId,
} from '../model/report.js';
import { checkStructureRules } from './structureRules.js';
import { checkCompositionRules } from './compositionRules.js';
import { checkPointFreeRules } from './pointFreeRules.js';
import { checkDeclarativePurityRules } from './declarativePurityRules.js';
import { checkBranchingRules } from './branchingRules.js';
import { checkTypeSafetyAndMonadRules } from './typeSafetyAndMonadRules.js';

export type RuleRunner = (ctx: RuleContext) => ReadonlyArray<DiagnosticError>;

const isoRuleId = iso<RuleId>();
const isoLine = iso<LineNumber>();
const isoCol = iso<ColumnNumber>();
const isoDiagMsg = iso<DiagnosticMessage>();

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

const diagnosticErrorKey = (e: DiagnosticError) => ({
  ruleId: isoRuleId.unwrap(e.ruleId),
  line: isoLine.unwrap(e.location.line),
  column: isoCol.unwrap(e.location.column),
  message: isoDiagMsg.unwrap(e.message),
});

const diagnosticErrorEq = Eq.contramap(diagnosticErrorKey)(
  Eq.struct({
    ruleId: S.Eq,
    line: N.Eq,
    column: N.Eq,
    message: S.Eq,
  }),
);

export const runAllRules = flow(
  executeRunners,
  RA.uniq(diagnosticErrorEq),
) satisfies RuleRunner;
