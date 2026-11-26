import * as B from 'fp-ts/lib/boolean.js';
import { constant, flow } from 'fp-ts/lib/function.js';
import * as N from 'fp-ts/lib/number.js';
import * as O from 'fp-ts/lib/Option.js';
import * as Ord from 'fp-ts/lib/Ord.js';
import * as RA from 'fp-ts/lib/ReadonlyArray.js';
import * as RNEA from 'fp-ts/lib/ReadonlyNonEmptyArray.js';
import * as S from 'fp-ts/lib/string.js';
import * as ts from 'typescript';
import type {
  BuiltProjectDag,
  CrossFileHint,
  ResolvedModuleData,
  DirectoryPath,
  LayerIndex,
  ModuleCount,
  RelativePath,
} from '../model/projectReport.js';
import type { FilePath } from '../graph/toRelativePosixPath.js';
import type { HintId } from '../model/report.js';
import { iso } from 'newtype-ts';
import type { BindingInfo, SymbolName, TypeInspector } from '../model/report.js';
const isoSymbolName = iso<SymbolName>();

export type PipelineMotifInput = {
  readonly dag: BuiltProjectDag;
  readonly checker: ts.TypeChecker;
  readonly inspector: TypeInspector;
  readonly minOcc: number;
};

type FlowRecord = {
  readonly file: string;
  readonly bindingName: string;
  readonly tokens: ReadonlyArray<string>;
};

type FlowNgram = {
  readonly key: string;
  readonly tokens: ReadonlyArray<string>;
  readonly file: string;
  readonly symbol: string;
};

type MotifSummary = {
  readonly key: string;
  readonly tokens: ReadonlyArray<string>;
  readonly files: ReadonlyArray<string>;
  readonly symbols: ReadonlyArray<string>;
};

const isFpNamespaceMethod = (method: string) =>
  new Set([
    'map',
    'chain',
    'chainW',
    'chainFirst',
    'chainEitherK',
    'chainEitherKW',
    'chainOptionK',
    'chainTaskK',
    'chainNullableK',
    'fromPredicate',
    'fromNullable',
    'fromOption',
    'fromEither',
    'tryCatch',
    'tryCatchK',
    'mapLeft',
    'bimap',
    'orElse',
    'alt',
    'fold',
    'match',
    'matchW',
    'getOrElse',
    'filter',
    'filterMap',
    'partitionMap',
    'traverse',
    'sequence',
    'reduce',
    'ap',
  ]).has(method);

const isFpConstructorMethod = (method: string) =>
  method === 'right' || method === 'left' || method === 'some';

const isOpticMethod = (method: string) =>
  method === 'unwrap' || method === 'wrap' || method === 'get' || method === 'modify';

const getIdentText = (id: ts.Identifier) => id.text;

const getObjectName = (expr: ts.Expression) =>
  O.getOrElse(constant('FP'))(O.map(getIdentText)(O.fromPredicate(ts.isIdentifier)(expr)));

const getFirstEffectOrPure = (effects: ReadonlyArray<string>) =>
  O.getOrElse(constant('Pure'))(RA.head(effects));

const detectStepEffectToken =
  (input: {
    readonly prefix: string;
    readonly checker: ts.TypeChecker;
    readonly inspector: TypeInspector;
  }) =>
  (node: ts.Expression) =>
    `${input.prefix}:${getFirstEffectOrPure(
      input.inspector.detectEffects(input.checker.getTypeAtLocation(node)),
    )}`;

const getPropName = (pa: ts.PropertyAccessExpression) => pa.name.text;
const getModuleBindings = (m: ResolvedModuleData) => m.ir.bindings;
const countTokens = (tokens: ReadonlyArray<string>) => tokens.length;
const listDagModules = (dag: BuiltProjectDag) => Array.from(dag.modules.values());
const isoHintId = iso<HintId>();
const isoFilePath = iso<FilePath>();
const isoRelativePath = iso<RelativePath>();
const isoDirectoryPath = iso<DirectoryPath>();
const isoLayerIndex = iso<LayerIndex>();
const isoModuleCount = iso<ModuleCount>();
const unwrapInit = (inspector: TypeInspector) => inspector.unwrapSatisfiesAndParens;

const classifyMethodAccess =
  (fallback: string) =>
  (pa: ts.PropertyAccessExpression) => {
    const method = getPropName(pa);
    return B.match(
      () => fallback,
      () => `${getObjectName(pa.expression)}.${method}`,
    )(isFpNamespaceMethod(method));
  };

const classifyCallExpr =
  (input: { readonly checker: ts.TypeChecker; readonly inspector: TypeInspector }) =>
  (unwrapped: ts.CallExpression) => {
    const fallback = detectStepEffectToken({
      prefix: 'call',
      checker: input.checker,
      inspector: input.inspector,
    })(unwrapped);
    return O.getOrElse(constant(fallback))(
      O.map(classifyMethodAccess(fallback))(
        O.fromPredicate(ts.isPropertyAccessExpression)(unwrapped.expression),
      ),
    );
  };

const classifyPropAccessExpr = (unwrapped: ts.PropertyAccessExpression) => {
  const method = getPropName(unwrapped);
  return B.match(
    () =>
      B.match(
        () => O.none,
        () => O.some(`Optic.${method}`),
      )(isOpticMethod(method)),
    () => O.some(`${getObjectName(unwrapped.expression)}.${method}`),
  )(isFpNamespaceMethod(method) || isFpConstructorMethod(method));
};

const classifyBinding = (binding: BindingInfo) =>
  B.match(
    () =>
      B.match(
        () => `step:${getFirstEffectOrPure(binding.effects)}`,
        () => 'Optic.op',
      )(binding.kind === 'optic'),
    () => 'ADT.match',
  )(binding.kind === 'adt-matcher');

const hasBindingName = (name: string) => (b: BindingInfo) => isoSymbolName.unwrap(b.name) === name;

const classifyIdentifierExpr =
  (input: {
    readonly mod: ResolvedModuleData;
    readonly checker: ts.TypeChecker;
    readonly inspector: TypeInspector;
  }) =>
  (unwrapped: ts.Identifier) =>
    O.match(
      () =>
        detectStepEffectToken({
          prefix: 'step',
          checker: input.checker,
          inspector: input.inspector,
        })(unwrapped),
      classifyBinding,
    )(RA.findFirst(hasBindingName(unwrapped.text))(getModuleBindings(input.mod)));

const classifyFlowStepToken =
  (input: {
    readonly mod: ResolvedModuleData;
    readonly checker: ts.TypeChecker;
    readonly inspector: TypeInspector;
  }) =>
  (expr: ts.Expression): string => {
    const unwrapped = unwrapInit(input.inspector)(expr);
    const fallback = detectStepEffectToken({
      prefix: 'step',
      checker: input.checker,
      inspector: input.inspector,
    })(unwrapped);
    const asCall = O.map(
      classifyCallExpr({ checker: input.checker, inspector: input.inspector }),
    )(O.fromPredicate(ts.isCallExpression)(unwrapped));
    const asProp = O.chain(classifyPropAccessExpr)(
      O.fromPredicate(ts.isPropertyAccessExpression)(unwrapped),
    );
    const asIdent = O.map(classifyIdentifierExpr(input))(
      O.fromPredicate(ts.isIdentifier)(unwrapped),
    );
    return O.getOrElse(constant(fallback))(
      RA.head(RA.compact([asCall, asProp, asIdent])),
    );
  };

const isConcreteCombinatorToken = (token: string) =>
  !token.startsWith('step:Pure') && !token.startsWith('call:Pure');

const isNonBarrel = (mod: ResolvedModuleData) => (mod.moduleKind !== 'barrel' && mod.moduleKind !== 'barrel-type-only');
const isTargetModule = (mod: ResolvedModuleData) => mod.scope === 'target';
const getRelativePath = (mod: ResolvedModuleData) => isoRelativePath.unwrap(mod.relativePath);

const inSet = (set: ReadonlySet<string>) => (value: string) => set.has(value);

const involvesAnyTarget = (dag: BuiltProjectDag) => (files: ReadonlyArray<string>) => {
  const targetFiles = new Set(
    RA.map(getRelativePath)(RA.filter(isTargetModule)(listDagModules(dag))),
  );
  return RA.some(inSet(targetFiles))(files);
};

const isFlowCallWithMinArgs =
  (inspector: TypeInspector) =>
  (node: ts.Expression): node is ts.CallExpression =>
    ts.isCallExpression(node) && inspector.isFlowCall(node) && node.arguments.length >= 3;

const buildFlowRecord =
  (input: {
    readonly mod: ResolvedModuleData;
    readonly checker: ts.TypeChecker;
    readonly inspector: TypeInspector;
    readonly bindingName: string;
  }) =>
  (call: ts.CallExpression): FlowRecord => ({
    file: isoRelativePath.unwrap(input.mod.relativePath),
    bindingName: input.bindingName,
    tokens: RA.map(
      classifyFlowStepToken({
        mod: input.mod,
        checker: input.checker,
        inspector: input.inspector,
      }),
    )(call.arguments),
  });

const extractBindingFlow =
  (input: {
    readonly mod: ResolvedModuleData;
    readonly checker: ts.TypeChecker;
    readonly inspector: TypeInspector;
  }) =>
  (binding: BindingInfo) =>
    O.map(
      buildFlowRecord({
        mod: input.mod,
        checker: input.checker,
        inspector: input.inspector,
        bindingName: isoSymbolName.unwrap(binding.name),
      }),
    )(
      O.chain(
        flow(
          input.inspector.unwrapSatisfiesAndParens,
          O.fromPredicate(isFlowCallWithMinArgs(input.inspector)),
        ),
      )(binding.initializer),
    );

const extractModuleFlows =
  (input: { readonly checker: ts.TypeChecker; readonly inspector: TypeInspector }) =>
  (mod: ResolvedModuleData) =>
    RA.filterMap(
      extractBindingFlow({ mod, checker: input.checker, inspector: input.inspector }),
    )(getModuleBindings(mod));

const identityNum = (i: number) => i;
const offsetBy = (base: number) => (offset: number) => base + offset;

const buildNgramAtStart =
  (input: { readonly flowRec: FlowRecord; readonly len: number }) =>
  (start: number): O.Option<FlowNgram> => {
    const slice = input.flowRec.tokens.slice(start, start + input.len);
    const concreteCount = RA.filter(isConcreteCombinatorToken)(slice).length;
    return B.match(
      () => O.none,
      () =>
        O.some({
          key: slice.join(' -> '),
          tokens: slice,
          file: input.flowRec.file,
          symbol: input.flowRec.bindingName,
        }),
    )(concreteCount >= 2);
  };

const extractNgramsForLen =
  (flowRec: FlowRecord) =>
  (len: number) =>
    RA.filterMap(buildNgramAtStart({ flowRec, len }))(
      RA.makeBy(countTokens(flowRec.tokens) - len + 1, identityNum),
    );

const extractFlowNgrams = (flowRec: FlowRecord) => {
  const maxLen = Math.min(countTokens(flowRec.tokens), 6);
  const lens = RA.makeBy(Math.max(0, maxLen - 2), offsetBy(3));
  return RA.chain(extractNgramsForLen(flowRec))(lens);
};

const getNgramKey = (n: FlowNgram) => n.key;
const getNgramFile = (n: FlowNgram) => n.file;
const getNgramSymbol = (n: FlowNgram) => n.symbol;
const sortStrings = RA.sortBy([S.Ord]);

const toMotifSummary = (
  entry: readonly [string, RNEA.ReadonlyNonEmptyArray<FlowNgram>],
) => {
  const [key, occs] = entry;
  return {
    key,
    tokens: occs[0].tokens,
    files: RA.uniq(S.Eq)(sortStrings(RA.map(getNgramFile)(occs))),
    symbols: RA.uniq(S.Eq)(sortStrings(RA.map(getNgramSymbol)(occs))),
  };
};

const hasMinFiles = (minOcc: number) => (m: MotifSummary) => m.files.length >= minOcc;

const negTokenLen = (m: MotifSummary) => -countTokens(m.tokens);
const negFileCount = (m: MotifSummary) => -m.files.length;
const byTokenLen = Ord.contramap(negTokenLen)(N.Ord);
const byFileCount = Ord.contramap(negFileCount)(N.Ord);
const sortMotifs = RA.sortBy([byTokenLen, byFileCount]);

const isMotifSubsumedBy = (cand: MotifSummary) => (kept: MotifSummary) =>
  RA.every(inSet(new Set(kept.files)))(cand.files) && kept.key.includes(cand.key);

const keepNonSubsumed =
  (sorted: ReadonlyArray<MotifSummary>) =>
  (pair: readonly [MotifSummary, number]) => {
    const [cand, idx] = pair;
    return !RA.some(isMotifSubsumedBy(cand))(sorted.slice(0, idx));
  };

const fstMotif = (pair: readonly [MotifSummary, number]) => pair[0];

const pruneSubMotifs = (sorted: ReadonlyArray<MotifSummary>) =>
  RA.map(fstMotif)(
    RA.filter(keepNonSubsumed(sorted))(
      RA.zip(RA.makeBy(sorted.length, identityNum))(sorted),
    ),
  );

const buildMotifHint = (pair: readonly [MotifSummary, number]) => {
  const [m, idx] = pair;
  return {
    hintId: isoHintId.wrap(`pipeline-motif-${idx + 1}`),
    category: 'pipeline-motif' as const,
    priority: B.match(
      () => 'medium' as const,
      () => 'high' as const,
    )(countTokens(m.tokens) >= 4 || m.files.length >= 4),
    files: m.files,
    symbols: m.symbols,
    evidence: `Recurring ${countTokens(m.tokens)}-step pipeline motif [${m.key}] repeats across ${m.files.length} modules (${m.files.join(', ')}).`,
    suggestion:
      'Extract a reusable generic higher-order combinator / Kleisli pipeline factory that encapsulates this repeated step sequence, passing domain-specific predicates/mappers as arguments.',
    suggestedSignature: O.some(
      'export type RunDomainPipeline = <A, B, E>(steps: PipelineSteps<A, B, E>) => (input: A) => Effect<E, B>;',
    ),
    researchQuestions: [
      `Do these ${m.files.length} pipelines share the same error-handling or validation lifecycle that can be captured by a single reusable combinator?`,
    ],
  };
};

const toMotifHint =
  (dag: BuiltProjectDag) =>
  (pair: readonly [MotifSummary, number]): O.Option<CrossFileHint> =>
    B.match(
      () => O.none,
      () => O.some(buildMotifHint(pair)),
    )(involvesAnyTarget(dag)(pair[0].files));

export const discoverPipelineMotifs = (({
  dag,
  checker,
  inspector,
  minOcc,
}: PipelineMotifInput): ReadonlyArray<CrossFileHint> => {
  const flows = RA.chain(extractModuleFlows({ checker, inspector }))(
    RA.filter(isNonBarrel)(listDagModules(dag)),
  );
  const ngrams = RA.chain(extractFlowNgrams)(flows);
  const grouped = RNEA.groupBy(getNgramKey)(ngrams);
  const valid = sortMotifs(
    RA.filter(hasMinFiles(minOcc))(RA.map(toMotifSummary)(Object.entries(grouped))),
  );
  const maximal = pruneSubMotifs(valid);
  return RA.filterMap(toMotifHint(dag))(
    RA.zip(RA.makeBy(maximal.length, identityNum))(maximal),
  );
}) satisfies (input: PipelineMotifInput) => ReadonlyArray<CrossFileHint>;
