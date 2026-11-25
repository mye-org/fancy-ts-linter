import { constant, flow } from 'fp-ts/lib/function.js';
import * as O from 'fp-ts/lib/Option.js';
import * as RA from 'fp-ts/lib/ReadonlyArray.js';
import { match } from 'ts-pattern';
import type {
  AgentHint,
  AnalysisReport,
  AnalysisSummary,
  DiagnosticError,
  HintPriority,
  TypeFlowEdge,
  TypeFlowGraph,
  TypeFlowNode,
} from '../model/report.js';

export type FormatReports = (reports: ReadonlyArray<AnalysisReport>) => string;

const formatLoc = (loc: { readonly line: number; readonly column: number }) =>
  `L${loc.line}:${loc.column}`;

const formatErrorLine = (e: DiagnosticError) =>
  `- **[${e.ruleId}]** (${e.category}) \`${formatLoc(e.location)}\`: ${e.message}\n  - Snippet: \`${e.snippet}\`\n  - Fix: ${e.fixGuidance}`;

const formatSignatureLine = (s: string) => `\n  - Signature: \`${s}\``;
const formatPriority = (p: HintPriority) => p.toUpperCase();
const joinQuestions = (qs: ReadonlyArray<string>) => qs.join(' | ');

const formatHintLine = (h: AgentHint) =>
  `- **[${formatPriority(h.priority)} | ${h.category}]** \`${formatLoc(h.location)}\`: ${h.evidence}\n  - Suggestion: ${h.suggestion}${O.match(constant(''), formatSignatureLine)(h.suggestedSignature)}\n  - Research: ${joinQuestions(h.researchQuestions)}`;

const formatNodeLine = (n: TypeFlowNode) =>
  `- \`${n.name}\` (${n.kind}, effects: [${n.effects.join(', ')}]): \`${n.signature}\``;

const formatEdgeLine = (e: TypeFlowEdge) =>
  `- \`${e.from}\` --(${e.role})--> \`${e.to}\``;

const formatSummaryLines = (s: AnalysisSummary) =>
  `- **Exported:** \`${O.getOrElse(constant('(none)'))(s.exportedFunction)}\` :: \`${O.getOrElse(constant('(unknown)'))(s.exportedSignature)}\`\n- **Errors:** ${s.errorCount} | **Hints:** ${s.hintCount}`;

const formatHeader = (r: AnalysisReport) =>
  `## [${match(r)
    .with({ passed: true }, constant('PASS'))
    .with({ passed: false }, constant('FAIL'))
    .exhaustive()}] ${r.filePath}\n${formatSummaryLines(r.summary)}`;

const formatNonEmptyErrors = (errors: ReadonlyArray<DiagnosticError>) =>
  `### Blocking Errors\n${RA.map(formatErrorLine)(errors).join('\n')}`;

const formatErrorSection = RA.match(
  constant('### Blocking Errors\nNone.'),
  formatNonEmptyErrors,
);

const formatNonEmptyHints = (hints: ReadonlyArray<AgentHint>) =>
  `### AI Refactoring & DDD Hints\n${RA.map(formatHintLine)(hints).join('\n')}`;

const formatHintSection = RA.match(
  constant('### AI Refactoring & DDD Hints\nNone.'),
  formatNonEmptyHints,
);

const formatNonEmptyNodes = (nodes: ReadonlyArray<TypeFlowNode>) =>
  `### Module Type-Flow Map\n${RA.map(formatNodeLine)(nodes).join('\n')}`;

const formatNodesSection = RA.match(
  constant('### Module Type-Flow Map\n(empty)'),
  formatNonEmptyNodes,
);

const formatNonEmptyEdges = (edges: ReadonlyArray<TypeFlowEdge>) =>
  `\n\n**Edges:**\n${RA.map(formatEdgeLine)(edges).join('\n')}`;

const formatEdgesSection = RA.match(constant(''), formatNonEmptyEdges);

const formatGraphSection = (g: TypeFlowGraph) =>
  `${formatNodesSection(g.nodes)}${formatEdgesSection(g.edges)}`;

const formatSingleReport = (r: AnalysisReport) =>
  [
    formatHeader(r),
    formatErrorSection(r.errors),
    formatHintSection(r.hints),
    formatGraphSection(r.typeFlowGraph),
  ].join('\n\n');

const joinReports = (parts: ReadonlyArray<string>) => parts.join('\n\n---\n\n');

export const formatMarkdownReports = flow(
  RA.map(formatSingleReport),
  joinReports,
) satisfies FormatReports;
