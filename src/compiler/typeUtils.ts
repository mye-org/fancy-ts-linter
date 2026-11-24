import { constant, flow, identity } from 'fp-ts/lib/function.js';
import * as B from 'fp-ts/lib/boolean.js';
import * as O from 'fp-ts/lib/Option.js';
import * as RA from 'fp-ts/lib/ReadonlyArray.js';
import * as S from 'fp-ts/lib/string.js';
import * as ts from 'typescript';
import { match, P } from 'ts-pattern';
import type { SourceLocation, TypeInspector } from '../model/report.js';

export type CreateTypeInspector = (checker: ts.TypeChecker) => TypeInspector;

const isStringElem = (target: string) => (list: ReadonlyArray<string>) =>
  RA.elem(S.Eq)(target)(list);

const getPosLineChar = (sf: ts.SourceFile) => (pos: number) =>
  sf.getLineAndCharacterOfPosition(pos);

const makeLocation = (sf: ts.SourceFile) => (node: ts.Node): SourceLocation => ({
  line: getPosLineChar(sf)(node.getStart(sf)).line + 1,
  column: getPosLineChar(sf)(node.getStart(sf)).character + 1,
  endLine: getPosLineChar(sf)(node.getEnd()).line + 1,
  endColumn: getPosLineChar(sf)(node.getEnd()).character + 1,
});

const getNodeText = (sf: ts.SourceFile) => (node: ts.Node) => node.getText(sf);
const collapseWhitespace = (text: string) => text.replace(/\s+/g, ' ').trim();

const truncate80 = (text: string) =>
  B.match(
    constant(text),
    constant(`${text.slice(0, 77)}...`),
  )(text.length > 80);

const makeSnippet = (sf: ts.SourceFile) =>
  flow(
    getNodeText(sf),
    collapseWhitespace,
    truncate80,
  );

const unwrapSatisfies = (e: ts.SatisfiesExpression): ts.Expression =>
  unwrapSatisfiesAndParens(e.expression);

const unwrapParens = (e: ts.ParenthesizedExpression): ts.Expression =>
  unwrapSatisfiesAndParens(e.expression);

const unwrapSatisfiesAndParens = (expr: ts.Expression): ts.Expression =>
  match(expr)
    .when(ts.isSatisfiesExpression, unwrapSatisfies)
    .when(ts.isParenthesizedExpression, unwrapParens)
    .otherwise(identity);

const readSymbolName = (s: ts.Symbol) => s.getName();
const getSymbolNameOpt = (symOpt: O.Option<ts.Symbol>): O.Option<string> =>
  O.map(readSymbolName)(symOpt);

const getDeclSourceFileName = (d: ts.Declaration) => d.getSourceFile().fileName;
const getFirstDecl = (sym: ts.Symbol) => O.fromNullable(sym.declarations?.[0]);
const getFirstDeclFile = flow(getFirstDecl, O.map(getDeclSourceFileName));

const includesFragment = (fragment: string) => (file: string) => file.includes(fragment);

const symbolFrom = (fragment: string) => (sym: ts.Symbol) =>
  O.exists(includesFragment(fragment))(getFirstDeclFile(sym));

const matchesFpTsSymbol = (name: string) => (sym: ts.Symbol) =>
  sym.getName() === name && symbolFrom('fp-ts')(sym);

const isFpTsFunctionSymbol = (name: string) => (checker: ts.TypeChecker) => (expr: ts.Expression) =>
  O.exists(matchesFpTsSymbol(name))(O.fromNullable(checker.getSymbolAtLocation(expr)));

const isCallNamed = (name: string) => (checker: ts.TypeChecker) => (node: ts.Node) =>
  ts.isCallExpression(node) &&
  (isFpTsFunctionSymbol(name)(checker)(node.expression) ||
    (ts.isIdentifier(node.expression) && node.expression.text === name));

const getEffectiveSymbol = (t: ts.Type): O.Option<ts.Symbol> =>
  O.alt(constant(O.fromNullable(t.getSymbol())))(O.fromNullable(t.aliasSymbol));

const getTypeSymbolName = flow(getEffectiveSymbol, getSymbolNameOpt);

const isUnarySig = (sig: ts.Signature) => sig.getParameters().length === 1;

const isUnaryFunctionType = (checker: ts.TypeChecker) => (type: ts.Type): boolean =>
  RA.isNonEmpty(type.getCallSignatures()) &&
  RA.every(isUnarySig)(type.getCallSignatures()) &&
  Boolean(checker);

const opticNames: ReadonlyArray<string> = [
  'Lens',
  'Prism',
  'Optional',
  'Traversal',
  'Iso',
  'Getter',
  'Setter',
  'Fold',
];

const typeclassNames: ReadonlyArray<string> = [
  'Eq',
  'Ord',
  'Semigroup',
  'Monoid',
  'Show',
];

const matchesOpticSymbol = (sym: ts.Symbol) =>
  isStringElem(sym.getName())(opticNames) &&
  (symbolFrom('monocle-ts')(sym) || symbolFrom('newtype-ts')(sym));

const isOpticType = (_checker: ts.TypeChecker) => (type: ts.Type): boolean =>
  O.exists(matchesOpticSymbol)(getEffectiveSymbol(type));

const matchesTypeclassSymbol = (sym: ts.Symbol) =>
  isStringElem(sym.getName())(typeclassNames) && symbolFrom('fp-ts')(sym);

const isTypeclassInstance = (_checker: ts.TypeChecker) => (type: ts.Type): boolean =>
  O.exists(matchesTypeclassSymbol)(getEffectiveSymbol(type));

const isNewtypeAlias = (sym: ts.Symbol) =>
  sym.getName() === 'Newtype' && symbolFrom('newtype-ts')(sym);

const isUriProp = (prop: ts.Symbol) => prop.getName() === '_URI';

const isNewtypeBrand = (_checker: ts.TypeChecker) => (type: ts.Type): boolean =>
  O.exists(isNewtypeAlias)(O.fromNullable(type.aliasSymbol)) ||
  RA.some(isUriProp)(type.getProperties());

const isTsPatternMatchCall = (node: ts.Node): boolean =>
  ts.isCallExpression(node) &&
  ts.isPropertyAccessExpression(node.expression) &&
  node.expression.name.text === 'exhaustive';

const isNullOrUndefinedFlag = (t: ts.Type) =>
  (t.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void)) !== 0;

const containerNames: ReadonlyArray<string> = [
  'Option',
  'None',
  'Some',
  'Either',
  'Task',
  'TaskEither',
  'Reader',
  'ReaderTask',
  'ReaderTaskEither',
  'State',
  'IO',
];

const isContainerName = (name: string) => isStringElem(name)(containerNames);
const isOptionOrEffectContainer = (t: ts.Type) =>
  O.exists(isContainerName)(getTypeSymbolName(t));

const isVoidCallReturn = (type: ts.Type) =>
  (type.flags & ts.TypeFlags.Void) !== 0 && RA.isNonEmpty(type.getCallSignatures());

const hasNullablePart = (checker: ts.TypeChecker) => (type: ts.Type): boolean =>
  B.match(
    constant(
      B.match(
        constant(
          isNullOrUndefinedFlag(type) ||
            (type.isUnion() && RA.some(hasNullablePart(checker))(type.types)),
        ),
        constant(false),
      )(isOptionOrEffectContainer(type)),
    ),
    constant(false),
  )(Boolean(checker) && isVoidCallReturn(type));

const isPromiseName = (n: string) => n === 'Promise' || n === 'PromiseLike';
const isPromiseType = (t: ts.Type) => O.exists(isPromiseName)(getTypeSymbolName(t));

const isTypeReference = (t: ts.Type): t is ts.TypeReference =>
  'target' in t && 'typeArguments' in t;

const getTypeArgsFromRef = (checker: ts.TypeChecker) => (ref: ts.TypeReference) =>
  checker.getTypeArguments(ref);

const getTypeArgs = (checker: ts.TypeChecker) => (t: ts.Type): ReadonlyArray<ts.Type> =>
  O.match(
    constant([] as ReadonlyArray<ts.Type>),
    getTypeArgsFromRef(checker),
  )(O.fromPredicate(isTypeReference)(t));

const hasRawPromise = (checker: ts.TypeChecker) => (type: ts.Type): boolean =>
  B.match(
    constant(
      isPromiseType(type) ||
        (type.isUnion() && RA.some(hasRawPromise(checker))(type.types)) ||
        RA.some(hasRawPromise(checker))(getTypeArgs(checker)(type)),
    ),
    constant(false),
  )(isOptionOrEffectContainer(type));

const boundaryMethods: ReadonlyArray<string> = [
  'fromNullable',
  'fromNullableK',
  'tryCatch',
  'tryCatchK',
  'of',
];

const isBoundaryLiftCall = (_checker: ts.TypeChecker) => (node: ts.Node): boolean =>
  ts.isCallExpression(node) &&
  ts.isPropertyAccessExpression(node.expression) &&
  isStringElem(node.expression.name.text)(boundaryMethods);

const effectMap: ReadonlyArray<readonly [string, string]> = [
  ['ReaderTaskEither', 'ReaderTaskEither'],
  ['TaskEither', 'TaskEither'],
  ['ReaderTask', 'ReaderTask'],
  ['Task', 'Task'],
  ['Either', 'Either'],
  ['Option', 'Option'],
  ['Reader', 'Reader'],
  ['State', 'State'],
  ['IO', 'IO'],
];

const matchesEffectKey = (name: string) => (e: readonly [string, string]) => e[0] === name;

const findEffectEntry = (name: string) =>
  RA.findFirst(matchesEffectKey(name))(effectMap);

const entryToArray = (entry: readonly [string, string]): ReadonlyArray<string> => [entry[1]];

const collectEffectsForName =
  (checker: ts.TypeChecker) =>
  (type: ts.Type) =>
  (name: string): ReadonlyArray<string> =>
    O.match(
      constant(RA.chain(collectEffectsFromType(checker))(getTypeArgs(checker)(type))),
      entryToArray,
    )(findEffectEntry(name));

const unwrapOptEffects =
  (checker: ts.TypeChecker) =>
  (type: ts.Type) =>
  (opt: O.Option<string>): ReadonlyArray<string> =>
    O.match(constant([] as ReadonlyArray<string>), collectEffectsForName(checker)(type))(opt);

const collectEffectsFromType = (checker: ts.TypeChecker) => (type: ts.Type): ReadonlyArray<string> =>
  match(getTypeSymbolName(type))
    .with(P.when(O.isSome), unwrapOptEffects(checker)(type))
    .otherwise(constant([] as ReadonlyArray<string>));

const dedupeStrings = RA.uniq(S.Eq);

const collectSigReturnEffects = (checker: ts.TypeChecker) => (sig: ts.Signature) =>
  collectEffectsFromType(checker)(sig.getReturnType());

const collectCallEffects = (checker: ts.TypeChecker) => (t: ts.Type) =>
  RA.chain(collectSigReturnEffects(checker))(t.getCallSignatures());

const fallbackPure = (effects: ReadonlyArray<string>): ReadonlyArray<string> =>
  B.match(constant(effects), constant(['Pure']))(effects.length === 0);

const detectEffects = (checker: ts.TypeChecker) =>
  flow(
    collectCallEffects(checker),
    dedupeStrings,
    fallbackPure,
  );

const formatTypeWith = (checker: ts.TypeChecker) => (t: ts.Type) =>
  checker.typeToString(t);

const buildInspector = (checker: ts.TypeChecker): TypeInspector => ({
  getLocation: makeLocation,
  getSnippet: makeSnippet,
  unwrapSatisfiesAndParens,
  isFlowCall: isCallNamed('flow')(checker),
  isPipeCall: isCallNamed('pipe')(checker),
  isUnaryFunctionType: isUnaryFunctionType(checker),
  isOpticType: isOpticType(checker),
  isTypeclassInstance: isTypeclassInstance(checker),
  isNewtypeBrand: isNewtypeBrand(checker),
  isTsPatternMatch: isTsPatternMatchCall,
  hasNullablePart: hasNullablePart(checker),
  hasRawPromise: hasRawPromise(checker),
  isBoundaryLiftCall: isBoundaryLiftCall(checker),
  detectEffects: detectEffects(checker),
  formatType: formatTypeWith(checker),
});

const validateChecker = (checker: ts.TypeChecker) => checker;

export const createTypeInspector = flow(
  validateChecker,
  buildInspector,
) satisfies CreateTypeInspector;
