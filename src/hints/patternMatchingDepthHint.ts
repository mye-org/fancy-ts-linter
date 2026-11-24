import { flow } from 'fp-ts/lib/function.js';
import * as O from 'fp-ts/lib/Option.js';
import * as RA from 'fp-ts/lib/ReadonlyArray.js';
import * as ts from 'typescript';
import type { AgentHint, BindingInfo, RuleContext } from '../model/report.js';

export type HintRunner = (ctx: RuleContext) => ReadonlyArray<AgentHint>;

const collectAllNodes = (sf: ts.SourceFile) => (node: ts.Node): ReadonlyArray<ts.Node> => [
  node,
  ...RA.chain(collectAllNodes(sf))(node.getChildren(sf)),
];

const isShallowTagWith = (sf: ts.SourceFile) => (call: ts.CallExpression): boolean =>
  ts.isPropertyAccessExpression(call.expression) &&
  call.expression.name.text === 'with' &&
  call.arguments.length >= 2 &&
  !call.arguments[0]!.getText(sf).includes('P.');

const checkMatcherDepth = (ctx: RuleContext) => (b: BindingInfo): ReadonlyArray<AgentHint> => {
  if (b.kind !== 'adt-matcher') {
    return [];
  }
  return O.match(
    () => [] as ReadonlyArray<AgentHint>,
    (expr: ts.Expression): ReadonlyArray<AgentHint> => {
      const nodes = collectAllNodes(ctx.sourceFile)(expr);
      const shallowWiths = RA.filter(
        (n: ts.Node): n is ts.CallExpression =>
          ts.isCallExpression(n) && isShallowTagWith(ctx.sourceFile)(n),
      )(nodes);

      const handlerNames = RA.filterMap((w: ts.CallExpression) => {
        const handler = w.arguments[1];
        return handler !== undefined && ts.isIdentifier(handler) ? O.some(handler.text) : O.none;
      })(shallowWiths);

      const hasNestedBranchInHandlers = RA.some((hName: string) =>
        RA.exists(
          (hb: BindingInfo) =>
            hb.name === hName &&
            (hb.kind === 'adt-matcher' ||
              O.exists((he: ts.Expression) =>
                /\b(fromPredicate|B\.match|match\()\b/.test(he.getText(ctx.sourceFile)),
              )(hb.initializer)),
        )(ctx.ir.bindings),
      )(handlerNames);

      const usesPSelect = expr.getText(ctx.sourceFile).includes('P.select');
      const usesPWhen = expr.getText(ctx.sourceFile).includes('P.when');

      if (!hasNestedBranchInHandlers && (usesPSelect || usesPWhen || shallowWiths.length < 2)) {
        return [];
      }

      return [
        {
          hintId: `pattern-depth-${b.name}`,
          category: 'pattern-matching-depth',
          priority: hasNestedBranchInHandlers ? 'high' : 'medium',
          location: { line: b.location.line, column: b.location.column },
          evidence: hasNestedBranchInHandlers
            ? `\`${b.name}\` uses shallow \`ts-pattern\` tag matching whose handlers branch again.`
            : `\`${b.name}\` uses flat \`match\` cases without structural patterns (\`P.select\`, \`P.when\`, \`P.union\`).`,
          suggestion:
            'Leverage `ts-pattern` deep structural matching: match nested fields directly with `P.when(pred)`, extract values with `P.select()`, or combine states with `match([a, b])`.',
          suggestedSignature: O.none,
          researchQuestions: [
            `Can secondary checks inside \`${handlerNames.join(', ')}\` be expressed directly in \`.with({ _tag: ..., field: P.when(...) }, ...)\`?`,
          ],
        },
      ];
    },
  )(b.initializer);
};

const runPatternDepthHints = (ctx: RuleContext): ReadonlyArray<AgentHint> =>
  RA.chain(checkMatcherDepth(ctx))(ctx.ir.bindings);

const identityCtx = (ctx: RuleContext) => ctx;

export const detectPatternMatchingDepthHints = flow(
  identityCtx,
  runPatternDepthHints,
) satisfies HintRunner;
