import { constant } from 'fp-ts/lib/function.js';
import * as O from 'fp-ts/lib/Option.js';
import * as RA from 'fp-ts/lib/ReadonlyArray.js';
import type {
  CrossFileHint,
  ProjectAnalysisReport,
  ProjectDagGraph,
  ProjectModuleNode,
} from '../model/projectReport.js';
import type { AgentHint, AnalysisReport, TypeFlowNode } from '../model/report.js';

export type FormatProjectReport = (report: ProjectAnalysisReport) => string;

const emptyRecord = constant({});
const emptyString = constant('');
const orEmptyString = O.getOrElse(emptyString);

const toSuggestedSignatureField = (suggestedSignature: string) => ({ suggestedSignature });
const optionalSuggestedSignature = O.match(emptyRecord, toSuggestedSignatureField);

const toStepCountField = (stepCount: number) => ({ stepCount });
const optionalStepCount = O.match(emptyRecord, toStepCountField);

const serializeHint = (h: AgentHint) => ({
  hintId: h.hintId,
  category: h.category,
  priority: h.priority,
  location: h.location,
  evidence: h.evidence,
  suggestion: h.suggestion,
  ...optionalSuggestedSignature(h.suggestedSignature),
  researchQuestions: h.researchQuestions,
});

const serializeCrossFileHint = (h: CrossFileHint) => ({
  hintId: h.hintId,
  category: h.category,
  priority: h.priority,
  files: h.files,
  symbols: h.symbols,
  evidence: h.evidence,
  suggestion: h.suggestion,
  ...optionalSuggestedSignature(h.suggestedSignature),
  researchQuestions: h.researchQuestions,
});

const serializeNode = (n: TypeFlowNode) => ({
  name: n.name,
  kind: n.kind,
  signature: n.signature,
  effects: n.effects,
  ...optionalStepCount(n.stepCount),
});

const serializeFileReport = (r: AnalysisReport) => ({
  filePath: r.filePath,
  passed: r.passed,
  summary: {
    errorCount: r.summary.errorCount,
    hintCount: r.summary.hintCount,
    exportedFunction: orEmptyString(r.summary.exportedFunction),
    exportedSignature: orEmptyString(r.summary.exportedSignature),
  },
  errors: r.errors,
  hints: RA.map(serializeHint)(r.hints),
  typeFlowGraph: {
    nodes: RA.map(serializeNode)(r.typeFlowGraph.nodes),
    edges: r.typeFlowGraph.edges,
  },
});

const serializeProjectNode = (n: ProjectModuleNode) => ({
  filePath: n.filePath,
  relativePath: n.relativePath,
  directory: n.directory,
  isTarget: n.isTarget,
  isBarrel: n.isBarrel,
  isTypeOnlyModule: n.isTypeOnlyModule,
  isEntrypoint: n.isEntrypoint,
  exportedFunction: orEmptyString(n.exportedFunction),
  exportedSignature: orEmptyString(n.exportedSignature),
  effects: n.effects,
  inDegree: n.inDegree,
  outDegree: n.outDegree,
  transitiveDependencyCount: n.transitiveDependencyCount,
  externalDependencies: n.externalDependencies,
  domainExternalDependencies: n.domainExternalDependencies,
  referencedDomainTypes: n.referencedDomainTypes,
  layer: n.layer,
});

const serializeProjectGraph = (g: ProjectDagGraph) => ({
  rootDir: g.rootDir,
  nodes: RA.map(serializeProjectNode)(g.nodes),
  edges: g.edges,
  cycles: g.cycles,
  directories: g.directories,
});

const toProjectGraphField = (g: ProjectDagGraph) => ({
  projectGraph: serializeProjectGraph(g),
});

const optionalProjectGraph = O.match(emptyRecord, toProjectGraphField);

const buildSerializableReport = (report: ProjectAnalysisReport) => ({
  passed: report.passed,
  summary: report.summary,
  files: RA.map(serializeFileReport)(report.files),
  projectGraphSummary: report.projectGraphSummary,
  ...optionalProjectGraph(report.projectGraph),
  crossFileHints: RA.map(serializeCrossFileHint)(report.crossFileHints),
});

export const formatJsonReports = ((report) =>
  JSON.stringify(buildSerializableReport(report), null, 2)) satisfies FormatProjectReport;
