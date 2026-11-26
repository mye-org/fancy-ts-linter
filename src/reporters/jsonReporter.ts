import * as O from 'fp-ts/lib/Option.js';
import type {
  CrossFileHint,
  ProjectAnalysisReport,
  ProjectDagGraph,
  ProjectModuleNode,
} from '../model/projectReport.js';
import type { AgentHint, AnalysisReport, TypeFlowNode } from '../model/report.js';

export type FormatProjectReport = (report: ProjectAnalysisReport) => string;

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

const serializeCrossFileHint = (h: CrossFileHint) => ({
  hintId: h.hintId,
  category: h.category,
  priority: h.priority,
  files: h.files,
  symbols: h.symbols,
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

const serializeFileReport = (r: AnalysisReport) => ({
  filePath: r.filePath,
  passed: r.passed,
  summary: {
    errorCount: r.summary.errorCount,
    hintCount: r.summary.hintCount,
    exportedFunction: O.getOrElse(() => '')(r.summary.exportedFunction),
    exportedSignature: O.getOrElse(() => '')(r.summary.exportedSignature),
  },
  errors: r.errors,
  hints: r.hints.map(serializeHint),
  typeFlowGraph: {
    nodes: r.typeFlowGraph.nodes.map(serializeNode),
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
  exportedFunction: O.getOrElse(() => '')(n.exportedFunction),
  exportedSignature: O.getOrElse(() => '')(n.exportedSignature),
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
  nodes: g.nodes.map(serializeProjectNode),
  edges: g.edges,
  cycles: g.cycles,
  directories: g.directories,
});

export const formatJsonReports: FormatProjectReport = (report) =>
  JSON.stringify(
    {
      passed: report.passed,
      summary: report.summary,
      files: report.files.map(serializeFileReport),
      projectGraphSummary: report.projectGraphSummary,
      ...(report.projectGraph !== undefined
        ? { projectGraph: serializeProjectGraph(report.projectGraph) }
        : {}),
      crossFileHints: report.crossFileHints.map(serializeCrossFileHint),
    },
    null,
    2,
  );
