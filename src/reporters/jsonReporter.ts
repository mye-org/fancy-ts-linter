import { constant, flow } from 'fp-ts/lib/function.js';
import * as O from 'fp-ts/lib/Option.js';
import * as RA from 'fp-ts/lib/ReadonlyArray.js';
import type { AgentHint, AnalysisReport, TypeFlowNode } from '../model/report.js';

export type FormatReports = (reports: ReadonlyArray<AnalysisReport>) => string;

const serializeHint = (h: AgentHint) => ({
  hintId: h.hintId,
  category: h.category,
  priority: h.priority,
  location: h.location,
  evidence: h.evidence,
  suggestion: h.suggestion,
  ...(O.isSome(h.suggestedSignature) ? { suggestedSignature: h.suggestedSignature.value } : {}),
  researchQuestions: h.researchQuestions,
});

const serializeNode = (n: TypeFlowNode) => ({
  name: n.name,
  kind: n.kind,
  signature: n.signature,
  effects: n.effects,
  ...(O.isSome(n.stepCount) ? { stepCount: n.stepCount.value } : {}),
});

const serializeReport = (r: AnalysisReport) => ({
  filePath: r.filePath,
  passed: r.passed,
  summary: {
    errorCount: r.summary.errorCount,
    hintCount: r.summary.hintCount,
    exportedFunction: O.getOrElse(constant(''))(r.summary.exportedFunction),
    exportedSignature: O.getOrElse(constant(''))(r.summary.exportedSignature),
  },
  errors: r.errors,
  hints: RA.map(serializeHint)(r.hints),
  typeFlowGraph: {
    nodes: RA.map(serializeNode)(r.typeFlowGraph.nodes),
    edges: r.typeFlowGraph.edges,
  },
});

const serializeAll = (reports: ReadonlyArray<AnalysisReport>) =>
  reports.length === 1 ? serializeReport(reports[0]!) : RA.map(serializeReport)(reports);

const stringifyPretty = (data: unknown) => JSON.stringify(data, null, 2);

export const formatJsonReports = flow(
  serializeAll,
  stringifyPretty,
) satisfies FormatReports;
