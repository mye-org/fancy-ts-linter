import * as B from 'fp-ts/lib/boolean.js';
import * as O from 'fp-ts/lib/Option.js';
import * as RA from 'fp-ts/lib/ReadonlyArray.js';
import * as ts from 'typescript';
import type { AgentHint, BindingInfo, RuleContext } from '../model/report.js';

export type HintRunner = (ctx: RuleContext) => ReadonlyArray<AgentHint>;

const prependChildren =
  (input: { readonly sf: ts.SourceFile; readonly rest: ReadonlyArray<ts.Node> }) =>
  (head: ts.Node): readonly [ts.Node, ReadonlyArray<ts.Node>] => [
    head,
    [...head.getChildren(input.sf), ...input.rest],
  ];

const stepNode = (sf: ts.SourceFile) => (stack: ReadonlyArray<ts.Node>) =>
  O.map(prependChildren({ sf, rest: stack.slice(1) }))(RA.head(stack));

const collectAllNodes = (sf: ts.SourceFile) => (root: ts.Node) => {
  const initial: ReadonlyArray<ts.Node> = [root];
  return RA.unfold(initial, stepNode(sf));
};

const hasNoPPattern = (sf: ts.SourceFile) => (arg: ts.Expression) =>
  !arg.getText(sf).includes('P.');

const isShallowTagWith = (sf: ts.SourceFile) => (call: ts.CallExpression) =>
  ts.isPropertyAccessExpression(call.expression) &&
  call.expression.name.text === 'with' &&
  call.arguments.length >= 2 &&
  O.exists(hasNoPPattern(sf))(RA.head(call.arguments));

const isShallowWithCall = (sf: ts.SourceFile) => (n: ts.Node): n is ts.CallExpression =>
  ts.isCallExpression(n) && isShallowTagWith(sf)(n);

const getIdentifierText = (id: ts.Identifier) => id.text;

const getHandlerName = (w: ts.CallExpression) =>
  O.map(getIdentifierText)(O.filter(ts.isIdentifier)(RA.lookup(1)(w.arguments)));

const hasBranchingText = (sf: ts.SourceFile) => (he: ts.Expression) =>
  /\b(fromPredicate|B\.match|match\()\b/.test(he.getText(sf));

const isBranchingHandlerBinding =
  (input: { readonly sf: ts.SourceFile; readonly hName: string }) => (hb: BindingInfo) =>
    hb.name === input.hName &&
    (hb.kind === 'adt-matcher' || O.exists(hasBranchingText(input.sf))(hb.initializer));

const hasHandlerBranching =
  (input: { readonly sf: ts.SourceFile; readonly bindings: ReadonlyArray<BindingInfo> }) =>
  (hName: string) =>
    RA.exists(isBranchingHandlerBinding({ sf: input.sf, hName }))(input.bindings);

type PatternHintInput = {
  readonly b: BindingInfo;
  readonly handlerNames: ReadonlyArray<string>;
  readonly hasNestedBranchInHandlers: boolean;
};

const buildPatternDepthHint = ({
  b,
  handlerNames,
  hasNestedBranchInHandlers,
}: PatternHintInput) => {
  const priority = B.match<'medium' | 'high'>(
    () => 'medium',
    () => 'high',
  )(hasNestedBranchInHandlers);
  const evidence = B.match(
    () =>
      `\`${b.name}\` uses flat \`match\` cases without structural patterns (\`P.select\`, \`P.when\`, \`P.union\`).`,
    () => `\`${b.name}\` uses shallow \`ts-pattern\` tag matching whose handlers branch again.`,
  )(hasNestedBranchInHandlers);

  return [
    {
      hintId: `pattern-depth-${b.name}`,
      category: 'pattern-matching-depth' as const,
      priority,
      location: { line: b.location.line, column: b.location.column },
      evidence,
      suggestion:
        'Leverage `ts-pattern` deep structural matching: match nested fields directly with `P.when(pred)`, extract values with `P.select()`, or combine states with `match([a, b])`.',
      suggestedSignature: O.none,
      researchQuestions: [
        `Can secondary checks inside \`${handlerNames.join(', ')}\` be expressed directly in \`.with({ _tag: ..., field: P.when(...) }, ...)\`?`,
      ],
    },
  ];
};

const analyzeMatcherExpr =
  (input: {
    readonly sf: ts.SourceFile;
    readonly bindings: ReadonlyArray<BindingInfo>;
    readonly b: BindingInfo;
  }) =>
  (expr: ts.Expression) => {
    const nodes = collectAllNodes(input.sf)(expr);
    const shallowWiths = RA.filter(isShallowWithCall(input.sf))(nodes);
    const handlerNames = RA.filterMap(getHandlerName)(shallowWiths);
    const hasNestedBranchInHandlers = RA.some(
      hasHandlerBranching({ sf: input.sf, bindings: input.bindings }),
    )(handlerNames);
    const exprText = expr.getText(input.sf);
    const usesPSelect = exprText.includes('P.select');
    const usesPWhen = exprText.includes('P.when');
    const shouldSkip = !hasNestedBranchInHandlers && (usesPSelect || usesPWhen || shallowWiths.length < 2);

    return B.match<ReadonlyArray<AgentHint>>(
      () => buildPatternDepthHint({ b: input.b, handlerNames, hasNestedBranchInHandlers }),
      () => [],
    )(shouldSkip);
  };

const checkMatcherDepth =
  (input: { readonly sf: ts.SourceFile; readonly bindings: ReadonlyArray<BindingInfo> }) =>
  (b: BindingInfo) =>
    B.match<ReadonlyArray<AgentHint>>(
      () => [],
      () =>
        O.match<ts.Expression, ReadonlyArray<AgentHint>>(
          () => [],
          analyzeMatcherExpr({ sf: input.sf, bindings: input.bindings, b }),
        )(b.initializer),
    )(b.kind === 'adt-matcher');

export const detectPatternMatchingDepthHints = ((ctx: RuleContext): ReadonlyArray<AgentHint> => {
  const bindings = ctx.ir.bindings;
  return RA.chain(checkMatcherDepth({ sf: ctx.sourceFile, bindings }))(bindings);
}) satisfies HintRunner;
