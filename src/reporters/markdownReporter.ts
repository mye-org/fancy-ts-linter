import * as B from 'fp-ts/lib/boolean.js';
import { constant } from 'fp-ts/lib/function.js';
import * as O from 'fp-ts/lib/Option.js';
import * as RA from 'fp-ts/lib/ReadonlyArray.js';
import type {
  CrossFileHint,
  DirectoryCohesionMetric,
  ProjectAnalysisReport,
  ProjectDagGraph,
  ProjectModuleNode,
} from '../model/projectReport.js';
import type {
  AgentHint,
  AnalysisReport,
  ColumnNumber,
  DiagnosticError,
  LineNumber,
} from '../model/report.js';

export type FormatProjectReport = (report: ProjectAnalysisReport) => string;

const emptyString = constant('');
const noneLabel = constant('(none)');
const unknownLabel = constant('(unknown)');
const orNoneLabel = O.getOrElse(noneLabel);
const orUnknownLabel = O.getOrElse(unknownLabel);
const isNonEmpty = (s: string) => s.length > 0;
const wrapBackticks = (s: string) => `\`${s}\``;
const formatLocation = (loc: { readonly line: LineNumber; readonly column: ColumnNumber }) =>
  `L${loc.line}:${loc.column}`;

const formatSuggestedSignature = (sig: string) => `\n  - Signature: \`${sig}\``;
const optionalSigPart = O.match(emptyString, formatSuggestedSignature);

const formatErrorLine = (e: DiagnosticError) =>
  `- **[${e.ruleId}]** (${e.category}) \`${formatLocation(e.location)}\`: ${e.message}\n  - Snippet: \`${e.snippet}\`\n  - Fix: ${e.fixGuidance}`;

const formatPriority = (h: { readonly priority: string }) => h.priority.toUpperCase();
const formatResearch = (h: { readonly researchQuestions: ReadonlyArray<string> }) =>
  h.researchQuestions.join(' | ');

const formatHintLine = (h: AgentHint) =>
  `- **[${formatPriority(h)} | ${h.category}]** \`${formatLocation(h.location)}\`: ${h.evidence}\n  - Suggestion: ${h.suggestion}${optionalSigPart(h.suggestedSignature)}\n  - Research: ${formatResearch(h)}`;

const formatSymbolsPart = (symbols: ReadonlyArray<string>) =>
  B.match(
    emptyString,
    () => `\n  - Symbols: ${RA.map(wrapBackticks)(symbols).join(', ')}`,
  )(symbols.length > 0);

const formatCrossFileHintLine = (h: CrossFileHint) => {
  const filesStr = RA.map(wrapBackticks)(h.files).join(', ');
  const symbolsPart = formatSymbolsPart(h.symbols);
  const sigPart = optionalSigPart(h.suggestedSignature);
  return `- **[${formatPriority(h)} | ${h.category}]** (${filesStr}): ${h.evidence}${symbolsPart}\n  - Suggestion: ${h.suggestion}${sigPart}\n  - Research: ${formatResearch(h)}`;
};

const formatReportStatus = (r: AnalysisReport) =>
  B.match(
    () => 'FAIL',
    () => 'PASS',
  )(r.passed);

const formatErrorSection = (errors: ReadonlyArray<DiagnosticError>) =>
  B.match(
    () => `### Blocking Errors\n${RA.map(formatErrorLine)(errors).join('\n')}`,
    () => '### Blocking Errors\nNone.',
  )(errors.length === 0);

const formatHintSection = (hints: ReadonlyArray<AgentHint>) =>
  B.match(
    () => `### AI Refactoring & DDD Hints\n${RA.map(formatHintLine)(hints).join('\n')}`,
    () => '### AI Refactoring & DDD Hints\nNone.',
  )(hints.length === 0);

const formatSingleReport = (r: AnalysisReport) => {
  const status = formatReportStatus(r);
  const exported = orNoneLabel(r.summary.exportedFunction);
  const sig = orUnknownLabel(r.summary.exportedSignature);
  const header = `## [${status}] ${r.filePath}\n- **Exported:** \`${exported}\` :: \`${sig}\`\n- **Errors:** ${r.summary.errorCount} | **Hints:** ${r.summary.hintCount}`;
  return [header, formatErrorSection(r.errors), formatHintSection(r.hints)].join('\n\n');
};

const formatNodeEffects = (effects: ReadonlyArray<string>) =>
  B.match(
    emptyString,
    () => `, effects=${effects.join('/')}`,
  )(effects.length > 0);

const formatGraphNodeLine = (n: ProjectModuleNode) =>
  `- \`${n.relativePath}\` (layer ${n.layer}, in=${n.inDegree}, out=${n.outDegree}, transitive=${n.transitiveDependencyCount}${formatNodeEffects(n.effects)})`;

const formatDirLine = (d: DirectoryCohesionMetric) =>
  `- \`${d.directory}\`: ${d.moduleCount} modules, ${d.clusterCount} clusters, cohesion=${d.cohesionScore}, avgCallerJaccard=${d.averageCallerJaccard}`;

const formatGraphDetails = (g: ProjectDagGraph) => {
  const nodeLines = RA.map(formatGraphNodeLine)(g.nodes);
  const dirLines = RA.map(formatDirLine)(g.directories);
  const nodesText = B.match(
    () => 'No modules.',
    () => nodeLines.join('\n'),
  )(nodeLines.length > 0);
  const dirsText = B.match(
    emptyString,
    () => `\n#### Directory Cohesion\n${dirLines.join('\n')}`,
  )(dirLines.length > 0);
  return RA.filter(isNonEmpty)(['### Project DAG Details', nodesText, dirsText]).join('\n');
};

const formatCrossFileHintsSection = (crossFileHints: ReadonlyArray<CrossFileHint>) =>
  B.match(
    () =>
      `### Cross-File Architectural & Pattern Hints\n${RA.map(formatCrossFileHintLine)(crossFileHints).join('\n')}`,
    () => '### Cross-File Architectural & Pattern Hints\nNone.',
  )(crossFileHints.length === 0);

const formatOptionalGraphDetails = O.match(emptyString, formatGraphDetails);

const formatProjectSection = (report: ProjectAnalysisReport) => {
  const g = report.projectGraphSummary;
  const header = [
    '## Project DAG & Cross-File Insights',
    `- **Analyzed Modules:** ${g.analyzedModuleCount} (Targets: ${g.targetFileCount}) | **Edges:** ${g.edgeCount} | **Cycles:** ${g.cycleCount} | **Directories:** ${g.directoryCount} | **Max Depth:** ${g.maxDepth}`,
    `- **Cross-File Hints:** ${report.summary.totalCrossFileHints}`,
  ].join('\n');
  const hintsSection = formatCrossFileHintsSection(report.crossFileHints);
  const graphSection = formatOptionalGraphDetails(report.projectGraph);
  return RA.filter(isNonEmpty)([header, hintsSection, graphSection]).join('\n\n');
};

export const formatMarkdownReports = ((report) =>
  [...RA.map(formatSingleReport)(report.files), formatProjectSection(report)].join(
    '\n\n---\n\n',
  )) satisfies FormatProjectReport;
