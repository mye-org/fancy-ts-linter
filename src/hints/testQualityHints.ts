import * as B from 'fp-ts/lib/boolean.js';
import { constant, flow } from 'fp-ts/lib/function.js';
import * as N from 'fp-ts/lib/number.js';
import * as O from 'fp-ts/lib/Option.js';
import * as Ord from 'fp-ts/lib/Ord.js';
import * as RA from 'fp-ts/lib/ReadonlyArray.js';
import * as S from 'fp-ts/lib/string.js';
import { iso } from 'newtype-ts';
import * as ts from 'typescript';
import type {
  AgentHint,
  HintEvidence,
  HintId,
  HintPriority,
  HintSuggestion,
  RuleContext,
} from '../model/report.js';

export type HintRunner = (ctx: RuleContext) => ReadonlyArray<AgentHint>;

const isoHintId = iso<HintId>();
const isoHintEvidence = iso<HintEvidence>();
const isoHintSuggestion = iso<HintSuggestion>();

const expandHeadNode =
  ({ sf, queue }: { readonly sf: ts.SourceFile; readonly queue: ReadonlyArray<ts.Node> }) =>
  (head: ts.Node): readonly [ts.Node, ReadonlyArray<ts.Node>] => [
    head,
    [...head.getChildren(sf), ...RA.dropLeft(1)(queue)],
  ];

const stepNodeQueue = (sf: ts.SourceFile) => (queue: ReadonlyArray<ts.Node>) =>
  O.map(expandHeadNode({ sf, queue }))(RA.head(queue));

const collectNodes = (sf: ts.SourceFile) => (root: ts.Node): ReadonlyArray<ts.Node> =>
  RA.unfold(RA.of<ts.Node>(root), stepNodeQueue(sf));

type MakeTestHintInput = {
  readonly hintId: string;
  readonly category: AgentHint['category'];
  readonly priority: HintPriority;
  readonly node: ts.Node;
  readonly evidence: string;
  readonly suggestion: string;
  readonly researchQuestions: ReadonlyArray<string>;
};

const makeTestHint =
  (ctx: RuleContext) =>
  ({
    hintId,
    category,
    priority,
    node,
    evidence,
    suggestion,
    researchQuestions,
  }: MakeTestHintInput): AgentHint => {
    const loc = ctx.inspector.getLocation(ctx.sourceFile)(node);
    return {
      hintId: isoHintId.wrap(hintId),
      category,
      priority,
      location: { line: loc.line, column: loc.column },
      evidence: isoHintEvidence.wrap(evidence),
      suggestion: isoHintSuggestion.wrap(suggestion),
      suggestedSignature: O.none,
      researchQuestions,
    };
  };

const getIdentifierText = (n: ts.Identifier) => n.text;

const formatIdentAndMember = (propName: string) => (id: ts.Identifier) =>
  `${id.text}.${propName}`;

const formatPropertyAccess = (pa: ts.PropertyAccessExpression): O.Option<string> =>
  O.map(formatIdentAndMember(pa.name.text))(O.fromPredicate(ts.isIdentifier)(pa.expression));

const getInnerParenExpr = (p: ts.ParenthesizedExpression): ts.Expression =>
  unwrapParenExpr(p.expression);

const unwrapParenExpr = (expr: ts.Expression): ts.Expression =>
  O.match(constant(expr), getInnerParenExpr)(O.fromPredicate(ts.isParenthesizedExpression)(expr));

const getCalleeName = (expr: ts.LeftHandSideExpression): O.Option<string> => {
  const unwrapped = unwrapParenExpr(expr);
  const identOpt = O.map(getIdentifierText)(O.fromPredicate(ts.isIdentifier)(unwrapped));
  return O.match(
    () => O.chain(formatPropertyAccess)(O.fromPredicate(ts.isPropertyAccessExpression)(unwrapped)),
    O.some<string>,
  )(identOpt);
};

const getMemberName = (pa: ts.PropertyAccessExpression) => pa.name.text;

const getCalleeMethodName = (expr: ts.LeftHandSideExpression): O.Option<string> => {
  const unwrapped = unwrapParenExpr(expr);
  const identOpt = O.map(getIdentifierText)(O.fromPredicate(ts.isIdentifier)(unwrapped));
  return O.match(
    () => O.map(getMemberName)(O.fromPredicate(ts.isPropertyAccessExpression)(unwrapped)),
    O.some<string>,
  )(identOpt);
};

const isTestCaseName = (name: string) => {
  const callees: ReadonlyArray<string> = [
    'it',
    'test',
    'it.only',
    'test.only',
    'it.concurrent',
    'test.concurrent',
  ];
  return RA.elem(S.Eq)(name)(callees);
};

const isTestCaseCall = (n: ts.Node): n is ts.CallExpression =>
  ts.isCallExpression(n) && O.exists(isTestCaseName)(getCalleeName(n.expression));

const isFunctionCallback = (n: ts.Node): n is ts.ArrowFunction | ts.FunctionExpression =>
  ts.isArrowFunction(n) || ts.isFunctionExpression(n);

const getTestCallback = (
  call: ts.CallExpression,
): O.Option<ts.ArrowFunction | ts.FunctionExpression> =>
  RA.findFirst(isFunctionCallback)(call.arguments);

// --- 1. test-missing-adt-variants ---

const isRelativeImportDecl = (n: ts.Node): n is ts.ImportDeclaration =>
  ts.isImportDeclaration(n) &&
  ts.isStringLiteral(n.moduleSpecifier) &&
  (n.moduleSpecifier.text.startsWith('./') || n.moduleSpecifier.text.startsWith('../'));

const getNamedImportElements = (ni: ts.NamedImports) => [...ni.elements];

const extractSpecifiersFromBindings = (bindings: ts.NamedImportBindings) =>
  O.match(constant(RA.zero<ts.ImportSpecifier>()), getNamedImportElements)(
    O.fromPredicate(ts.isNamedImports)(bindings),
  );

const extractSpecifiersFromClause = (clause: ts.ImportClause) =>
  O.match(constant(RA.zero<ts.ImportSpecifier>()), extractSpecifiersFromBindings)(
    O.fromNullable(clause.namedBindings),
  );

const getNamedImportSpecifiers = (
  decl: ts.ImportDeclaration,
): ReadonlyArray<ts.ImportSpecifier> =>
  O.match(constant(RA.zero<ts.ImportSpecifier>()), extractSpecifiersFromClause)(
    O.fromNullable(decl.importClause),
  );

const getSymbolDecl = (sym: ts.Symbol): O.Option<ts.Declaration> => {
  const fromDecls = O.chain(RA.head)(O.fromNullable(sym.declarations));
  return O.match(constant(fromDecls), O.some<ts.Declaration>)(O.fromNullable(sym.valueDeclaration));
};

const isStringLiteralType = (t: ts.Type): t is ts.StringLiteralType => t.isStringLiteral();
const getLiteralValue = (t: ts.StringLiteralType) => t.value;

const getStringLiteralTypeValue = (t: ts.Type) =>
  O.map(getLiteralValue)(O.fromPredicate(isStringLiteralType)(t));

const getMemberSymbolType =
  (checker: ts.TypeChecker) =>
  (propSym: ts.Symbol) =>
  (decl: ts.Declaration) =>
    getStringLiteralTypeValue(checker.getTypeOfSymbolAtLocation(propSym, decl));

const resolveSymbolLiteral =
  (checker: ts.TypeChecker) => (propSym: ts.Symbol) =>
    O.chain(getMemberSymbolType(checker)(propSym))(getSymbolDecl(propSym));

const extractTagFromMemberProp =
  (checker: ts.TypeChecker) =>
  (propName: string) =>
  (member: ts.Type): O.Option<string> =>
    O.chain(resolveSymbolLiteral(checker))(O.fromNullable(member.getProperty(propName)));

const extractTagsForProp =
  (checker: ts.TypeChecker) =>
  (members: ReadonlyArray<ts.Type>) =>
  (propName: string): ReadonlyArray<string> => {
    const tags = RA.filterMap(extractTagFromMemberProp(checker)(propName))(members);
    return B.match(
      constant(RA.zero<string>()),
      constant(tags),
    )(tags.length >= 2 && tags.length === members.length);
  };

const isUnionType = (tp: ts.Type): tp is ts.UnionType => tp.isUnion();

const extractTagsFromUnion =
  (checker: ts.TypeChecker) =>
  (props: ReadonlyArray<string>) =>
  (u: ts.UnionType) =>
    RA.chain(extractTagsForProp(checker)(u.types))(props);

const extractUnionAdtTags =
  (checker: ts.TypeChecker) => (t: ts.Type): ReadonlyArray<string> => {
    const discriminantPropNames: ReadonlyArray<string> = [
      '_tag',
      'tag',
      'kind',
      'type',
      'status',
    ];
    return O.match(
      constant(RA.zero<string>()),
      extractTagsFromUnion(checker)(discriminantPropNames),
    )(O.fromPredicate(isUnionType)(t));
  };

const getTypeAtDecl =
  (checker: ts.TypeChecker) => (p: ts.Symbol) => (decl: ts.Declaration) =>
    checker.getTypeOfSymbolAtLocation(p, decl);

const getParamType =
  (checker: ts.TypeChecker) => (p: ts.Symbol): ts.Type =>
    O.match(() => checker.getAnyType(), getTypeAtDecl(checker)(p))(getSymbolDecl(p));

const collectSignatureTypes =
  (checker: ts.TypeChecker) => (sig: ts.Signature): ReadonlyArray<ts.Type> => [
    ...RA.map(getParamType(checker))(sig.getParameters()),
    checker.getReturnTypeOfSignature(sig),
  ];

const getSutAdtTags =
  (checker: ts.TypeChecker) => (spec: ts.ImportSpecifier): ReadonlyArray<string> => {
    const symType = checker.getTypeAtLocation(spec);
    const sigs = checker.getSignaturesOfType(symType, ts.SignatureKind.Call);
    const sigTypes = RA.chain(collectSignatureTypes(checker))(sigs);
    return RA.uniq(S.Eq)(RA.chain(extractUnionAdtTags(checker))(sigTypes));
  };

const isStringLitOrNoSub = (
  n: ts.Node,
): n is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral =>
  ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n);

const getLitNodeText = (lit: ts.StringLiteral | ts.NoSubstitutionTemplateLiteral) => lit.text;

const getStringLiteralText = (n: ts.Node) =>
  O.map(getLitNodeText)(O.fromPredicate(isStringLitOrNoSub)(n));

const getCallExprMethodName = (c: ts.CallExpression) => getCalleeMethodName(c.expression);

const getCalledMethodName = (n: ts.Node) =>
  O.chain(getCallExprMethodName)(O.fromPredicate(ts.isCallExpression)(n));

const collectCalledMethodNames = RA.filterMap(getCalledMethodName);

const isElemIn = (names: ReadonlyArray<string>) => (c: string) => RA.elem(S.Eq)(c)(names);

const tagIfAnyCall =
  (called: ReadonlyArray<string>) =>
  (names: ReadonlyArray<string>) =>
  (tag: string): ReadonlyArray<string> =>
    B.match(
      constant(RA.zero<string>()),
      constant([tag]),
    )(RA.exists(isElemIn(names))(called));

const collectCoveredTags = (nodes: ReadonlyArray<ts.Node>): ReadonlyArray<string> => {
  const literals = RA.filterMap(getStringLiteralText)(nodes);
  const called = collectCalledMethodNames(nodes);
  const tagIf = tagIfAnyCall(called);
  return RA.uniq(S.Eq)([
    ...literals,
    ...tagIf(['left', 'isLeft', 'match', 'fold'])('Left'),
    ...tagIf(['right', 'isRight', 'match', 'fold'])('Right'),
    ...tagIf(['none', 'isNone', 'match', 'fold'])('None'),
    ...tagIf(['some', 'isSome', 'match', 'fold'])('Some'),
  ]);
};

const wrapBacktick = (s: string) => `\`${s}\``;

const isNotCovered = (covered: ReadonlyArray<string>) => (tag: string) =>
  !RA.elem(S.Eq)(tag)(covered);

const checkSpecMissingAdt =
  (ctx: RuleContext) =>
  (covered: ReadonlyArray<string>) =>
  (spec: ts.ImportSpecifier): ReadonlyArray<AgentHint> => {
    const tags = getSutAdtTags(ctx.checker)(spec);
    const missing = RA.filter(isNotCovered(covered))(tags);
    return B.match(
      constant(RA.zero<AgentHint>()),
      () => [
        makeTestHint(ctx)({
          hintId: `test-missing-adt-variants-${spec.name.text}`,
          category: 'test-coverage',
          priority: 'high',
          node: spec,
          evidence: `SUT \`${spec.name.text}\` uses Discriminated Union variant(s) (${tags.join(', ')}), but tests do not cover: ${missing.join(', ')}.`,
          suggestion: `Add unit test cases covering the missing variant(s): ${RA.map(wrapBacktick)(missing).join(', ')}.`,
          researchQuestions: [
            `What should \`${spec.name.text}\` return or do for ${missing.join(', ')}?`,
          ],
        }),
      ],
    )(tags.length >= 2 && missing.length > 0);
  };

const detectMissingAdtVariants =
  (ctx: RuleContext) => (nodes: ReadonlyArray<ts.Node>): ReadonlyArray<AgentHint> => {
    const covered = collectCoveredTags(nodes);
    const specs = RA.chain(getNamedImportSpecifiers)(RA.filter(isRelativeImportDecl)(nodes));
    return RA.chain(checkSpecMissingAdt(ctx)(covered))(specs);
  };

// --- 2. test-multiple-behaviors ---

const isAssertionRoot = (root: string) => {
  const roots: ReadonlyArray<string> = ['expect', 'assert', 'expectTypeOf', 'should'];
  return RA.elem(S.Eq)(root)(roots);
};

const isAssertionName = (name: string) =>
  O.exists(isAssertionRoot)(RA.head(name.split('.')));

const isAssertionCall = (n: ts.Node) =>
  ts.isCallExpression(n) && O.exists(isAssertionName)(getCalleeName(n.expression));

const evaluateTestBodyAssertions =
  (ctx: RuleContext) =>
  (call: ts.CallExpression) =>
  (cb: ts.ArrowFunction | ts.FunctionExpression): ReadonlyArray<AgentHint> => {
    const assertions = RA.filter(isAssertionCall)(collectNodes(ctx.sourceFile)(cb.body));
    return B.match(
      constant(RA.zero<AgentHint>()),
      () => [
        makeTestHint(ctx)({
          hintId: `test-multiple-behaviors-${ctx.inspector.getLocation(ctx.sourceFile)(call).line}`,
          category: 'test-design',
          priority: 'medium',
          node: call,
          evidence: `Test case contains ${assertions.length} assertions, which suggests testing multiple behaviors in a single \`it\`/\`test\` block.`,
          suggestion:
            'Split this test into focused, single-behavior `it(...)` cases so each failure pinpoints one broken invariant.',
          researchQuestions: [
            'Can each assertion group be expressed as its own Arrange-Act-Assert scenario?',
          ],
        }),
      ],
    )(assertions.length >= 4);
  };

const checkCallMultipleBehaviors =
  (ctx: RuleContext) =>
  (call: ts.CallExpression): ReadonlyArray<AgentHint> =>
    O.match(constant(RA.zero<AgentHint>()), evaluateTestBodyAssertions(ctx)(call))(
      getTestCallback(call),
    );

const detectMultipleBehaviors =
  (ctx: RuleContext) => (nodes: ReadonlyArray<ts.Node>): ReadonlyArray<AgentHint> =>
    RA.chain(checkCallMultipleBehaviors(ctx))(RA.filter(isTestCaseCall)(nodes));

// --- 3. test-smell-excessive-mocking ---

const isMockMethodName = (m: string) => {
  const names: ReadonlyArray<string> = ['mock', 'doMock', 'spyOn', 'fn', 'stub'];
  return RA.elem(S.Eq)(m)(names);
};

const isMockSetupCall = (n: ts.Node) =>
  ts.isCallExpression(n) && O.exists(isMockMethodName)(getCalleeMethodName(n.expression));

const buildExcessiveMockHint =
  (ctx: RuleContext) =>
  (mockCount: number) =>
  (firstMock: ts.Node): ReadonlyArray<AgentHint> =>
    B.match(
      constant(RA.zero<AgentHint>()),
      () => [
        makeTestHint(ctx)({
          hintId: 'test-smell-excessive-mocking',
          category: 'test-code-smell',
          priority: 'high',
          node: firstMock,
          evidence: `Test file uses ${mockCount} mock/spy setups, indicating high coupling or mixed I/O in the module under test.`,
          suggestion:
            'Extract pure domain logic into a Functional Core (`Either`) tested without mocks, and isolate side effects in a thin Imperative Shell (`ReaderTaskEither`).',
          researchQuestions: [
            'Which mocked dependencies are actually pure transformations that can be passed as values?',
            'Can I/O ports be injected via `Reader` / `ReaderTaskEither` instead of module-level mocks?',
          ],
        }),
      ],
    )(mockCount >= 3);

const detectExcessiveMocking =
  (ctx: RuleContext) => (nodes: ReadonlyArray<ts.Node>): ReadonlyArray<AgentHint> => {
    const mocks = RA.filter(isMockSetupCall)(nodes);
    return O.match(constant(RA.zero<AgentHint>()), buildExcessiveMockHint(ctx)(mocks.length))(
      RA.head(mocks),
    );
  };

// --- 4. test-smell-bloated-fixture ---

const getPropAssignmentDepth = (pa: ts.PropertyAssignment) =>
  O.match(constant(0), getObjectNestingDepth)(
    O.fromPredicate(ts.isObjectLiteralExpression)(pa.initializer),
  );

const getPropInitializerDepth = (prop: ts.ObjectLiteralElementLike): number =>
  O.match(constant(0), getPropAssignmentDepth)(O.fromPredicate(ts.isPropertyAssignment)(prop));

const maxOrZero = flow(RA.sortBy([N.Ord]), RA.last, O.getOrElse(constant(0)));

const getObjectNestingDepth = (obj: ts.ObjectLiteralExpression): number => {
  const childDepths = RA.map(getPropInitializerDepth)(obj.properties);
  return 1 + maxOrZero(childDepths);
};

const isOutermostObjectLiteral = (n: ts.Node): n is ts.ObjectLiteralExpression =>
  ts.isObjectLiteralExpression(n) &&
  n.parent !== undefined &&
  !ts.isPropertyAssignment(n.parent) &&
  !ts.isObjectLiteralExpression(n.parent);

const checkBloatedObject =
  (ctx: RuleContext) =>
  (obj: ts.ObjectLiteralExpression): ReadonlyArray<AgentHint> => {
    const propCount = obj.properties.length;
    const depth = getObjectNestingDepth(obj);
    return B.match(
      constant(RA.zero<AgentHint>()),
      () => [
        makeTestHint(ctx)({
          hintId: `test-smell-bloated-fixture-${ctx.inspector.getLocation(ctx.sourceFile)(obj).line}`,
          category: 'test-code-smell',
          priority: 'medium',
          node: obj,
          evidence: `Test fixture object has ${propCount} properties and nesting depth ${depth}, indicating a bloated input record.`,
          suggestion:
            'Decompose the SUT input into cohesive Value Objects (`missing-domain-model`) or split the function (`ddd-decomposition`) so tests only construct relevant fields.',
          researchQuestions: [
            'Does the SUT actually read all of these fields, or is it accepting an oversized god-record?',
          ],
        }),
      ],
    )(propCount >= 8 || depth >= 3);
  };

const detectBloatedFixtures =
  (ctx: RuleContext) => (nodes: ReadonlyArray<ts.Node>): ReadonlyArray<AgentHint> =>
    RA.chain(checkBloatedObject(ctx))(RA.filter(isOutermostObjectLiteral)(nodes));

// --- 5. test-smell-combinatorial-explosion ---

const isCallToIdentifier = (name: string) => (n: ts.Node) =>
  ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name;

const callbackCallsIdentifier =
  (sf: ts.SourceFile) =>
  (name: string) =>
  (cb: ts.ArrowFunction | ts.FunctionExpression) =>
    RA.exists(isCallToIdentifier(name))(collectNodes(sf)(cb.body));

const testCallsIdentifier =
  (sf: ts.SourceFile) =>
  (name: string) =>
  (call: ts.CallExpression): boolean =>
    O.exists(callbackCallsIdentifier(sf)(name))(getTestCallback(call));

const checkSpecCombinatorial =
  (ctx: RuleContext) =>
  (testCalls: ReadonlyArray<ts.CallExpression>) =>
  (spec: ts.ImportSpecifier): ReadonlyArray<AgentHint> => {
    const matchingTests = RA.filter(testCallsIdentifier(ctx.sourceFile)(spec.name.text))(
      testCalls,
    );
    return B.match(
      constant(RA.zero<AgentHint>()),
      () => [
        makeTestHint(ctx)({
          hintId: `test-smell-combinatorial-explosion-${spec.name.text}`,
          category: 'test-code-smell',
          priority: 'medium',
          node: spec,
          evidence: `SUT \`${spec.name.text}\` requires ${matchingTests.length} separate test cases in this file, signaling high branching or flag complexity.`,
          suggestion:
            'Check if the SUT can be decomposed into smaller single-responsibility modules (`ddd-decomposition`) or replace boolean flags with an ADT (`adt-over-flags`).',
          researchQuestions: [
            `Is \`${spec.name.text}\` handling multiple orthogonal responsibilities that should be separate functions?`,
          ],
        }),
      ],
    )(matchingTests.length >= 8);
  };

const detectCombinatorialExplosion =
  (ctx: RuleContext) => (nodes: ReadonlyArray<ts.Node>): ReadonlyArray<AgentHint> => {
    const specs = RA.chain(getNamedImportSpecifiers)(RA.filter(isRelativeImportDecl)(nodes));
    const testCalls = RA.filter(isTestCaseCall)(nodes);
    return RA.chain(checkSpecCombinatorial(ctx)(testCalls))(specs);
  };

// --- 6. test-smell-async-ceremony ---

const isAsyncCeremonyName = (m: string) => {
  const callees: ReadonlyArray<string> = [
    'useFakeTimers',
    'useRealTimers',
    'advanceTimersByTime',
    'runAllTimers',
    'waitFor',
    'setTimeout',
  ];
  return RA.elem(S.Eq)(m)(callees);
};

const isAsyncCeremonyCall = (n: ts.Node) =>
  ts.isCallExpression(n) && O.exists(isAsyncCeremonyName)(getCalleeMethodName(n.expression));

const buildAsyncCeremonyHint =
  (ctx: RuleContext) =>
  (first: ts.Node): ReadonlyArray<AgentHint> => [
    makeTestHint(ctx)({
      hintId: 'test-smell-async-ceremony',
      category: 'test-code-smell',
      priority: 'medium',
      node: first,
      evidence:
        'Test relies on fake timers or async wait ceremony (`useFakeTimers` / `waitFor` / `setTimeout`).',
      suggestion:
        'If domain logic requires timer/async ceremony to test, extract the pure state transitions from the `TaskEither`/`Promise` shell.',
      researchQuestions: [
        'Can the time-dependent or async logic be separated from pure domain calculations?',
      ],
    }),
  ];

const detectAsyncCeremony =
  (ctx: RuleContext) => (nodes: ReadonlyArray<ts.Node>): ReadonlyArray<AgentHint> =>
    O.match(constant(RA.zero<AgentHint>()), buildAsyncCeremonyHint(ctx))(
      RA.head(RA.filter(isAsyncCeremonyCall)(nodes)),
    );

const priorityWeight = (p: HintPriority) => {
  const weights: Record<HintPriority, number> = { high: 0, medium: 1, low: 2 };
  return weights[p];
};

const getHintPriorityWeight = (h: AgentHint) => priorityWeight(h.priority);

const byPriority = Ord.contramap(getHintPriorityWeight)(N.Ord);

export const detectTestQualityHints = ((ctx) => {
  const nodes = collectNodes(ctx.sourceFile)(ctx.sourceFile);
  const hints = [
    ...detectMissingAdtVariants(ctx)(nodes),
    ...detectMultipleBehaviors(ctx)(nodes),
    ...detectExcessiveMocking(ctx)(nodes),
    ...detectBloatedFixtures(ctx)(nodes),
    ...detectCombinatorialExplosion(ctx)(nodes),
    ...detectAsyncCeremony(ctx)(nodes),
  ];
  return RA.sortBy([byPriority])(hints);
}) satisfies HintRunner;
