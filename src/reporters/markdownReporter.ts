import * as O from 'fp-ts/lib/Option.js';
import type {
  CrossFileHint,
  ProjectAnalysisReport,
  ProjectDagGraph,
} from '../model/projectReport.js';
import type { AgentHint, AnalysisReport, DiagnosticError } from '../model/report.js';

export type FormatProjectReport = (report: ProjectAnalysisReport) => string;

const formatErrorLine = (e: DiagnosticError): string =>
  `- **[${e.ruleId}]** (${e.category}) \`L${e.location.line}:${e.location.column}\`: ${e.message}\n  - Snippet: \`${e.snippet}\`\n  - Fix: ${e.fixGuidance}`;

const formatHintLine = (h: AgentHint): string =>
  `- **[${h.priority.toUpperCase()} | ${h.category}]** \`L${h.location.line}:${h.location.column}\`: ${h.evidence}\n  - Suggestion: ${h.suggestion}${O.isSome(h.suggestedSignature) ? `\n  - Signature: \`${h.suggestedSignature.value}\`` : ''}\n  - Research: ${h.researchQuestions.join(' | ')}`;

const formatCrossFileHintLine = (h: CrossFileHint): string => {
  const filesStr = h.files.map((f) => `\`${f}\``).join(', ');
  const symbolsPart = h.symbols.length > 0 ? `\n  - Symbols: ${h.symbols.map((s) => `\`${s}\``).join(', ')}` : '';
  const sigPart = O.isSome(h.suggestedSignature)
    ? `\n  - Signature: \`${h.suggestedSignature.value}\``
    : '';
  return `- **[${h.priority.toUpperCase()} | ${h.category}]** (${filesStr}): ${h.evidence}${symbolsPart}\n  - Suggestion: ${h.suggestion}${sigPart}\n  - Research: ${h.researchQuestions.join(' | ')}`;
};

const formatSingleReport = (r: AnalysisReport): string => {
  const status = r.passed ? 'PASS' : 'FAIL';
  const exported = O.getOrElse(() => '(none)')(r.summary.exportedFunction);
  const sig = O.getOrElse(() => '(unknown)')(r.summary.exportedSignature);

  const header = `## [${status}] ${r.filePath}\n- **Exported:** \`${exported}\` :: \`${sig}\`\n- **Errors:** ${r.summary.errorCount} | **Hints:** ${r.summary.hintCount}`;

  const errorSection =
    r.errors.length === 0
      ? '### Blocking Errors\nNone.'
      : `### Blocking Errors\n${r.errors.map(formatErrorLine).join('\n')}`;

  const hintSection =
    r.hints.length === 0
      ? '### AI Refactoring & DDD Hints\nNone.'
      : `### AI Refactoring & DDD Hints\n${r.hints.map(formatHintLine).join('\n')}`;

  return [header, errorSection, hintSection].join('\n\n');
};

const formatGraphDetails = (g: ProjectDagGraph): string => {
  const nodeLines = g.nodes.map(
    (n) =>
      `- \`${n.relativePath}\` (layer ${n.layer}, in=${n.inDegree}, out=${n.outDegree}, transitive=${n.transitiveDependencyCount}${n.effects.length > 0 ? `, effects=${n.effects.join('/')}` : ''})`,
  );
  const dirLines = g.directories.map(
    (d) =>
      `- \`${d.directory}\`: ${d.moduleCount} modules, ${d.clusterCount} clusters, cohesion=${d.cohesionScore}, avgCallerJaccard=${d.averageCallerJaccard}`,
  );
  return [
    '### Project DAG Details',
    nodeLines.length > 0 ? nodeLines.join('\n') : 'No modules.',
    dirLines.length > 0 ? `\n#### Directory Cohesion\n${dirLines.join('\n')}` : '',
  ]
    .filter((s) => s.length > 0)
    .join('\n');
};

const formatProjectSection = (report: ProjectAnalysisReport): string => {
  const g = report.projectGraphSummary;
  const header = [
    '## Project DAG & Cross-File Insights',
    `- **Analyzed Modules:** ${g.analyzedModuleCount} (Targets: ${g.targetFileCount}) | **Edges:** ${g.edgeCount} | **Cycles:** ${g.cycleCount} | **Directories:** ${g.directoryCount} | **Max Depth:** ${g.maxDepth}`,
    `- **Cross-File Hints:** ${report.summary.totalCrossFileHints}`,
  ].join('\n');

  const hintsSection =
    report.crossFileHints.length === 0
      ? '### Cross-File Architectural & Pattern Hints\nNone.'
      : `### Cross-File Architectural & Pattern Hints\n${report.crossFileHints.map(formatCrossFileHintLine).join('\n')}`;

  const sections = [header, hintsSection];
  if (report.projectGraph !== undefined) {
    sections.push(formatGraphDetails(report.projectGraph));
  }
  return sections.join('\n\n');
};

export const formatMarkdownReports: FormatProjectReport = (report) => {
  const fileSections = report.files.map(formatSingleReport);
  const sections = [...fileSections, formatProjectSection(report)];
  return sections.join('\n\n---\n\n');
};
