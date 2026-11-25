import { constant, flow } from 'fp-ts/lib/function.js';
import * as O from 'fp-ts/lib/Option.js';
import * as RA from 'fp-ts/lib/ReadonlyArray.js';
import { match, P } from 'ts-pattern';
import type {
  AgentHint,
  AnalysisReport,
  AnalysisSummary,
  TypeFlowGraph,
  TypeFlowNode,
} from '../model/report.js';

export type FormatReports = (reports: ReadonlyArray<AnalysisReport>) => string;

const toSuggestedSignatureField = (suggestedSignature: string) => ({ suggestedSignature });
const toStepCountField = (stepCount: number) => ({ stepCount });

const serializeHint = (h: AgentHint) => ({
  hintId: h.hintId,
  category: h.category,
  priority: h.priority,
  location: h.location,
  evidence: h.evidence,
  suggestion: h.suggestion,
  ...O.match(constant({}), toSuggestedSignatureField)(h.suggestedSignature),
  researchQuestions: h.researchQuestions,
});

const serializeNode = (n: TypeFlowNode) => ({
  name: n.name,
  kind: n.kind,
  signature: n.signature,
  effects: n.effects,
  ...O.match(constant({}), toStepCountField)(n.stepCount),
});

const serializeSummary = (s: AnalysisSummary) => ({
  errorCount: s.errorCount,
  hintCount: s.hintCount,
  exportedFunction: O.getOrElse(constant(''))(s.exportedFunction),
  exportedSignature: O.getOrElse(constant(''))(s.exportedSignature),
});

const serializeGraph = (g: TypeFlowGraph) => ({
  nodes: RA.map(serializeNode)(g.nodes),
  edges: g.edges,
});

const serializeReport = (r: AnalysisReport) => ({
  filePath: r.filePath,
  passed: r.passed,
  summary: serializeSummary(r.summary),
  errors: r.errors,
  hints: RA.map(serializeHint)(r.hints),
  typeFlowGraph: serializeGraph(r.typeFlowGraph),
});

const serializeAll = (reports: ReadonlyArray<AnalysisReport>) =>
  match(reports)
    .with([P.select()], serializeReport)
    .otherwise(RA.map(serializeReport));

const stringifyPretty = (data: unknown) => JSON.stringify(data, null, 2);

export const formatJsonReports = flow(
  serializeAll,
  stringifyPretty,
) satisfies FormatReports;
