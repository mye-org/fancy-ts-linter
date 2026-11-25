import { constant, flow } from 'fp-ts/lib/function.js';
import * as O from 'fp-ts/lib/Option.js';
import * as RA from 'fp-ts/lib/ReadonlyArray.js';
import type {
  AgentHint,
  AnalysisReport,
  DiagnosticError,
} from '../model/report.js';

export type FormatReports = (reports: ReadonlyArray<AnalysisReport>) => string;

const formatErrorLine = (e: DiagnosticError): string =>
  `- **[${e.ruleId}]** (${e.category}) \`L${e.location.line}:${e.location.column}\`: ${e.message}\n  - Snippet: \`${e.snippet}\`\n  - Fix: ${e.fixGuidance}`;

const formatHintLine = (h: AgentHint): string =>
  `- **[${h.priority.toUpperCase()} | ${h.category}]** \`L${h.location.line}:${h.location.column}\`: ${h.evidence}\n  - Suggestion: ${h.suggestion}${O.match(constant(''), (s: string) => `\n  - Signature: \`${s}\``)(h.suggestedSignature)}\n  - Research: ${h.researchQuestions.join(' | ')}`;

const formatSingleReport = (r: AnalysisReport): string => {
  const status = r.passed ? 'PASS' : 'FAIL';
  const exported = O.getOrElse(constant('(none)'))(r.summary.exportedFunction);
  const sig = O.getOrElse(constant('(unknown)'))(r.summary.exportedSignature);

  const header = `## [${status}] ${r.filePath}\n- **Exported:** \`${exported}\` :: \`${sig}\`\n- **Errors:** ${r.summary.errorCount} | **Hints:** ${r.summary.hintCount}`;

  const errorSection =
    r.errors.length === 0
      ? '### Blocking Errors\nNone.'
      : `### Blocking Errors\n${RA.map(formatErrorLine)(r.errors).join('\n')}`;

  const hintSection =
    r.hints.length === 0
      ? '### AI Refactoring & DDD Hints\nNone.'
      : `### AI Refactoring & DDD Hints\n${RA.map(formatHintLine)(r.hints).join('\n')}`;

  return [header, errorSection, hintSection].join('\n\n');
};

const joinReports = (parts: ReadonlyArray<string>): string => parts.join('\n\n---\n\n');

export const formatMarkdownReports = flow(
  RA.map(formatSingleReport),
  joinReports,
) satisfies FormatReports;
