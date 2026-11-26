import * as B from 'fp-ts/lib/boolean.js';
import { flow } from 'fp-ts/lib/function.js';
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
} from '../model/projectReport.js';
import type { TypeDeclInfo } from '../model/report.js';

export type MissingDomainModelInput = {
  readonly dag: BuiltProjectDag;
  readonly checker: ts.TypeChecker;
  readonly minOcc: number;
};

type ShapeField = {
  readonly key: string;
  readonly name: string;
  readonly typeText: string;
};

type ObjectShapeRecord = {
  readonly file: string;
  readonly typeName: string;
  readonly fields: ReadonlyArray<ShapeField>;
};

type FilteredShape = {
  readonly file: string;
  readonly typeName: string;
  readonly keys: ReadonlyArray<string>;
};

type FieldCluster = {
  readonly keys: ReadonlyArray<string>;
  readonly files: ReadonlyArray<string>;
  readonly types: ReadonlyArray<string>;
};

type TaggedAdtOccurrence = {
  readonly key: string;
  readonly tags: ReadonlyArray<string>;
  readonly file: string;
  readonly symbol: string;
};

type DomainPrimitiveOccurrence = {
  readonly key: string;
  readonly name: string;
  readonly prim: 'string' | 'number';
  readonly file: string;
  readonly typeName: string;
};

type FieldFilePair = {
  readonly key: string;
  readonly file: string;
};

type IrFieldLike = TypeDeclInfo['fields'][number];

const sortStrings = RA.sortBy([S.Ord]);
const identityNum = (i: number) => i;
const inSet = (set: ReadonlySet<string>) => (value: string) => set.has(value);

const normalizeTypeText = (raw: string) =>
  raw.replace(/\s+/g, ' ').replace(/\breadonly\s+/g, '').trim();

const formatCapitalized = (part: string) => (first: string) =>
  `${first.toUpperCase()}${part.slice(1)}`;

const capitalizePart = (part: string) =>
  B.match(
    () => '',
    () => O.match(() => '', formatCapitalized(part))(O.fromNullable(part[0])),
  )(part.length > 0);

const toPascalCase = (s: string) =>
  RA.map(capitalizePart)(s.replace(/[^a-zA-Z0-9]+/g, ' ').trim().split(/\s+/)).join('');

const isGenericFieldName = (name: string) =>
  new Set([
    'id',
    'name',
    'value',
    'type',
    '_tag',
    'kind',
    'error',
    'message',
    'data',
    'result',
    'input',
    'output',
    'item',
    'items',
    'status',
  ]).has(name);

const isDomainPrimitiveFieldName = (name: string) =>
  /(?:Id|Uuid|Email|Currency|Code|Amount|Price|Subtotal|Total|Cents|Url|Uri|Token|Phone|Slug|IsoDate|Timestamp|Percent|Rate|Zip|Tenant|AccountKey|Hash|Signature)$/i.test(
    name,
  );

const isTargetModule = (mod: ResolvedModuleData) => mod.isTarget;
const isNonBarrel = (mod: ResolvedModuleData) => !mod.isBarrel;
const getRelativePath = (mod: ResolvedModuleData) => mod.relativePath;

const involvesAnyTarget = (dag: BuiltProjectDag) => (files: ReadonlyArray<string>) => {
  const targetFiles = new Set(
    RA.map(getRelativePath)(RA.filter(isTargetModule)(Array.from(dag.modules.values()))),
  );
  return RA.some(inSet(targetFiles))(files);
};

const isPrimitiveFlagged = (t: ts.Type) =>
  (t.flags &
    (ts.TypeFlags.StringLike |
      ts.TypeFlags.NumberLike |
      ts.TypeFlags.BooleanLike |
      ts.TypeFlags.BigIntLike |
      ts.TypeFlags.ESSymbolLike |
      ts.TypeFlags.Void |
      ts.TypeFlags.Undefined |
      ts.TypeFlags.Null |
      ts.TypeFlags.Never |
      ts.TypeFlags.Any |
      ts.TypeFlags.Unknown)) !==
  0;

const isPrimitiveOrLiteralUnion = (t: ts.Type) =>
  isPrimitiveFlagged(t) || (t.isUnion() && RA.every(isPrimitiveFlagged)(t.types));

const getFieldKey = (f: ShapeField) => f.key;
const byFieldKey = Ord.contramap(getFieldKey)(S.Ord);
const sortFields = RA.sortBy([byFieldKey]);

const prependChildren =
  (input: { readonly sf: ts.SourceFile; readonly rest: ReadonlyArray<ts.Node> }) =>
  (head: ts.Node): readonly [ts.Node, ReadonlyArray<ts.Node>] => [
    head,
    [...head.getChildren(input.sf), ...input.rest],
  ];

const stepNode = (sf: ts.SourceFile) => (stack: ReadonlyArray<ts.Node>) =>
  O.map(prependChildren({ sf, rest: stack.slice(1) }))(RA.head(stack));

const collectAllNodes = (sf: ts.SourceFile) => {
  const initial: ReadonlyArray<ts.Node> = [sf];
  return RA.unfold(initial, stepNode(sf));
};

const toShapeFieldFromIr = (f: { readonly name: string; readonly typeText: string }) => {
  const typeText = normalizeTypeText(f.typeText);
  return { name: f.name, typeText, key: `${f.name}:${typeText}` };
};

const isEligibleTypeDecl =
  (checker: ts.TypeChecker) =>
  (td: TypeDeclInfo) =>
    !td.isNewtype &&
    !td.isDiscriminatedUnion &&
    td.fields.length >= 2 &&
    !isPrimitiveOrLiteralUnion(checker.getTypeAtLocation(td.node));

const toDeclShape =
  (file: string) =>
  (td: TypeDeclInfo): ObjectShapeRecord => ({
    file,
    typeName: td.name,
    fields: sortFields(RA.map(toShapeFieldFromIr)(td.fields)),
  });

const toSymbolShapeField =
  (input: { readonly checker: ts.TypeChecker; readonly node: ts.Node }) =>
  (prop: ts.Symbol): ShapeField => {
    const pt = normalizeTypeText(
      input.checker.typeToString(input.checker.getTypeOfSymbolAtLocation(prop, input.node)),
    );
    return { name: prop.getName(), typeText: pt, key: `${prop.getName()}:${pt}` };
  };

const isInlineTypeLiteral = (node: ts.Node): node is ts.TypeLiteralNode =>
  ts.isTypeLiteralNode(node) && !ts.isTypeAliasDeclaration(node.parent);

const extractInlineShape =
  (input: { readonly file: string; readonly checker: ts.TypeChecker }) =>
  (node: ts.TypeLiteralNode): O.Option<ObjectShapeRecord> => {
    const type = input.checker.getTypeAtLocation(node);
    const props = type.getProperties();
    return B.match(
      () => O.none,
      () =>
        O.some({
          file: input.file,
          typeName: '(inline)',
          fields: sortFields(
            RA.map(toSymbolShapeField({ checker: input.checker, node }))(props),
          ),
        }),
    )(!isPrimitiveOrLiteralUnion(type) && props.length >= 2);
  };

const collectModuleObjectShapes =
  (checker: ts.TypeChecker) =>
  (mod: ResolvedModuleData): ReadonlyArray<ObjectShapeRecord> => {
    const declShapes = RA.map(toDeclShape(mod.relativePath))(
      RA.filter(isEligibleTypeDecl(checker))(mod.ir.typeDeclarations),
    );
    const inlineShapes = RA.filterMap(
      flow(
        O.fromPredicate(isInlineTypeLiteral),
        O.chain(extractInlineShape({ file: mod.relativePath, checker })),
      ),
    )(collectAllNodes(mod.sourceFile));
    return [...declShapes, ...inlineShapes];
  };

const collectObjectShapes = (input: {
  readonly dag: BuiltProjectDag;
  readonly checker: ts.TypeChecker;
}) =>
  RA.chain(collectModuleObjectShapes(input.checker))(
    RA.filter(isNonBarrel)(Array.from(input.dag.modules.values())),
  );

const buildPairCluster =
  (targetRelFiles: ReadonlySet<string>) =>
  (pair: readonly [FilteredShape, FilteredShape]): O.Option<ReadonlyArray<string>> => {
    const [a, b] = pair;
    const aSet = new Set(a.keys);
    const sameFile = a.file === b.file;
    const neitherTarget = !targetRelFiles.has(a.file) && !targetRelFiles.has(b.file);
    const inter = RA.filter(inSet(aSet))(b.keys);
    return B.match(
      () => O.none,
      () => O.some(inter),
    )(!sameFile && !neitherTarget && inter.length >= 2);
  };

const pairWithFirst =
  <A>(a: A) =>
  (b: A): readonly [A, A] => [a, b];

const mapPairsWithFirst =
  <A>(rest: ReadonlyArray<A>) =>
  (a: A): ReadonlyArray<readonly [A, A]> =>
    RA.map(pairWithFirst(a))(rest);

const makePairsForIndex =
  <A>(items: ReadonlyArray<A>) =>
  (idx: number): ReadonlyArray<readonly [A, A]> =>
    O.match(() => [], mapPairsWithFirst(items.slice(idx + 1)))(RA.lookup(idx)(items));

const makeShapePairs = <A>(items: ReadonlyArray<A>): ReadonlyArray<readonly [A, A]> =>
  RA.chain(makePairsForIndex(items))(RA.makeBy(items.length, identityNum));

const extractFieldName = (key: string) => {
  const sep = key.indexOf(':');
  return B.match(
    () => key,
    () => key.slice(0, sep),
  )(sep >= 0);
};

const isNonGenericFieldKey = (key: string) => !isGenericFieldName(extractFieldName(key));

const isValidCluster =
  (minOcc: number) =>
  (c: FieldCluster) => {
    const nonGenericCount = RA.filter(isNonGenericFieldKey)(c.keys).length;
    return (
      c.files.length >= minOcc &&
      (nonGenericCount >= 2 || (c.keys.length >= 3 && nonGenericCount >= 1))
    );
  };

const negKeyLen = (c: FieldCluster) => -c.keys.length;
const negFileCount = (c: FieldCluster) => -c.files.length;
const byClusterSize = Ord.contramap(negKeyLen)(N.Ord);
const byClusterFiles = Ord.contramap(negFileCount)(N.Ord);
const sortClusters = RA.sortBy([byClusterSize, byClusterFiles]);

const isSubsumedBy =
  (cand: FieldCluster) =>
  (kept: FieldCluster) =>
    RA.every(inSet(new Set(kept.files)))(cand.files) &&
    RA.every(inSet(new Set(kept.keys)))(cand.keys);

const keepNonSubsumedCluster =
  (sorted: ReadonlyArray<FieldCluster>) =>
  (pair: readonly [FieldCluster, number]) => {
    const [cand, idx] = pair;
    return !RA.some(isSubsumedBy(cand))(sorted.slice(0, idx));
  };

const fstCluster = (pair: readonly [FieldCluster, number]) => pair[0];

const pruneSubsumedClusters = (sorted: ReadonlyArray<FieldCluster>) =>
  RA.map(fstCluster)(
    RA.filter(keepNonSubsumedCluster(sorted))(
      RA.zip(RA.makeBy(sorted.length, identityNum))(sorted),
    ),
  );

const formatReadableField = (k: string) => {
  const sep = k.indexOf(':');
  return `readonly ${k.slice(0, sep)}: ${k.slice(sep + 1)}`;
};

const buildFieldClusterHint = (input: {
  readonly cluster: FieldCluster;
  readonly idx: number;
  readonly files: ReadonlyArray<string>;
}) => {
  const fieldsReadable = RA.map(formatReadableField)(input.cluster.keys);
  const fieldNames = RA.map(extractFieldName)(input.cluster.keys);
  const rawSuggested = toPascalCase(fieldNames.slice(0, 2).join('_'));
  const suggestedName = B.match(
    () => 'SharedValueObject',
    () => rawSuggested,
  )(rawSuggested.length > 0);
  return {
    hintId: `missing-domain-model-fields-${input.idx + 1}`,
    category: 'missing-domain-model' as const,
    priority: B.match(
      () => 'medium' as const,
      () => 'high' as const,
    )(input.cluster.keys.length >= 3 || input.files.length >= 4),
    files: input.files,
    symbols: sortStrings(input.cluster.types),
    evidence: `Field cluster { ${fieldsReadable.join('; ')} } is duplicated across ${input.files.length} modules (${input.files.join(', ')}) without a shared domain type.`,
    suggestion: `Extract a canonical Value Object / Domain Model type (e.g. "${suggestedName}") into a shared domain types module and compose it instead of repeating these fields.`,
    suggestedSignature: O.some(
      `export type ${suggestedName} = { ${fieldsReadable.join('; ')} };`,
    ),
    researchQuestions: [
      `Do { ${fieldNames.join(', ')} } represent a cohesive domain concept or invariant that should be validated once at construction?`,
    ],
  };
};

const toFieldClusterHint =
  (dag: BuiltProjectDag) =>
  (pair: readonly [FieldCluster, number]): O.Option<CrossFileHint> => {
    const [cluster, idx] = pair;
    const files = sortStrings(cluster.files);
    return B.match(
      () => O.none,
      () => O.some(buildFieldClusterHint({ cluster, idx, files })),
    )(involvesAnyTarget(dag)(files));
  };

const toFieldFilePair =
  (file: string) =>
  (f: ShapeField): FieldFilePair => ({ key: f.key, file });

const toFieldFilePairs = (s: ObjectShapeRecord) =>
  RA.map(toFieldFilePair(s.file))(s.fields);

const getPairKey = (p: FieldFilePair) => p.key;
const getPairFile = (p: FieldFilePair) => p.file;

const filterFrequentKey =
  (minOcc: number) =>
  (entry: readonly [string, RNEA.ReadonlyNonEmptyArray<FieldFilePair>]): O.Option<string> => {
    const [k, occs] = entry;
    const distinctFiles = RA.uniq(S.Eq)(RA.map(getPairFile)(occs));
    return B.match(
      () => O.none,
      () => O.some(k),
    )(distinctFiles.length >= minOcc);
  };

const toFilteredShape =
  (frequentFields: ReadonlySet<string>) =>
  (s: ObjectShapeRecord): FilteredShape => ({
    file: s.file,
    typeName: s.typeName,
    keys: RA.filter(inSet(frequentFields))(RA.map(getFieldKey)(s.fields)),
  });

const hasAtLeastTwoKeys = (s: FilteredShape) => s.keys.length >= 2;
const joinKeys = (ks: ReadonlyArray<string>) => ks.join('|');
const getFilteredFile = (s: FilteredShape) => s.file;
const getFilteredTypeName = (s: FilteredShape) => s.typeName;
const isNotInlineType = (t: string) => t !== '(inline)';

const shapeHasAllKeys =
  (keys: ReadonlyArray<string>) =>
  (s: FilteredShape) =>
    RA.every(inSet(new Set(s.keys)))(keys);

const buildClusterFromSig =
  (perFileFiltered: ReadonlyArray<FilteredShape>) =>
  (sig: string): FieldCluster => {
    const keys = sig.split('|');
    const matchingShapes = RA.filter(shapeHasAllKeys(keys))(perFileFiltered);
    const files = RA.uniq(S.Eq)(RA.map(getFilteredFile)(matchingShapes));
    const types = RA.uniq(S.Eq)(
      RA.filter(isNotInlineType)(RA.map(getFilteredTypeName)(matchingShapes)),
    );
    return { keys, files, types };
  };

const computeFieldClusterHints = (input: {
  readonly dag: BuiltProjectDag;
  readonly minOcc: number;
  readonly shapes: ReadonlyArray<ObjectShapeRecord>;
  readonly frequentFields: ReadonlySet<string>;
}) => {
  const perFileFiltered = RA.filter(hasAtLeastTwoKeys)(
    RA.map(toFilteredShape(input.frequentFields))(input.shapes),
  );
  const targetRelFiles = new Set(
    RA.map(getRelativePath)(RA.filter(isTargetModule)(Array.from(input.dag.modules.values()))),
  );
  const rawCandidateKeys = RA.filterMap(buildPairCluster(targetRelFiles))(
    makeShapePairs(perFileFiltered),
  );
  const uniqueCandidateSigs = RA.uniq(S.Eq)(RA.map(joinKeys)(rawCandidateKeys));
  const candidateClusters = RA.map(buildClusterFromSig(perFileFiltered))(uniqueCandidateSigs);
  const valid = sortClusters(RA.filter(isValidCluster(input.minOcc))(candidateClusters));
  const maximal = pruneSubsumedClusters(valid);
  return RA.filterMap(toFieldClusterHint(input.dag))(
    RA.zip(RA.makeBy(maximal.length, identityNum))(maximal),
  );
};

const detectRepeatedFieldClusters = (input: MissingDomainModelInput) => {
  const shapes = collectObjectShapes({ dag: input.dag, checker: input.checker });
  const fieldPairs = RA.chain(toFieldFilePairs)(shapes);
  const groupedFields = RNEA.groupBy(getPairKey)(fieldPairs);
  const frequentFields = new Set(
    RA.filterMap(filterFrequentKey(input.minOcc))(Object.entries(groupedFields)),
  );
  return B.match(
    () => [],
    () =>
      computeFieldClusterHints({
        dag: input.dag,
        minOcc: input.minOcc,
        shapes,
        frequentFields,
      }),
  )(frequentFields.size >= 2);
};

const isStringLiteralType = (t: ts.Type) => t.isStringLiteral();
const getLiteralValue = (lit: ts.StringLiteralType) => lit.value;
const isUnionType = (t: ts.Type) => t.isUnion();
const getUnionTypes = (u: ts.UnionType) => u.types;

const readTagPropValue =
  (input: { readonly checker: ts.TypeChecker; readonly node: ts.Node }) =>
  (sym: ts.Symbol): O.Option<string> => {
    const propType = input.checker.getTypeOfSymbolAtLocation(sym, input.node);
    return O.map(getLiteralValue)(O.fromPredicate(isStringLiteralType)(propType));
  };

const extractMemberTag =
  (input: { readonly checker: ts.TypeChecker; readonly node: ts.Node }) =>
  (member: ts.Type): O.Option<string> => {
    const tagProp = RA.head(
      RA.compact([
        O.fromNullable(member.getProperty('_tag')),
        O.fromNullable(member.getProperty('kind')),
        O.fromNullable(member.getProperty('type')),
      ]),
    );
    return O.chain(readTagPropValue(input))(tagProp);
  };

const extractAdtOccurrence =
  (input: { readonly file: string; readonly checker: ts.TypeChecker }) =>
  (td: TypeDeclInfo): O.Option<TaggedAdtOccurrence> => {
    const type = input.checker.getTypeAtLocation(td.node);
    const unionMembers = O.match(
      () => [],
      getUnionTypes,
    )(O.fromPredicate(isUnionType)(type));
    const tags = RA.uniq(S.Eq)(
      sortStrings(RA.filterMap(extractMemberTag({ checker: input.checker, node: td.node }))(unionMembers)),
    );
    return B.match(
      () => O.none,
      () =>
        O.some({
          key: tags.join('|'),
          tags,
          file: input.file,
          symbol: td.name,
        }),
    )(td.isDiscriminatedUnion && type.isUnion() && tags.length >= 2);
  };

const collectModuleAdtOccurrences =
  (checker: ts.TypeChecker) =>
  (mod: ResolvedModuleData) =>
    RA.filterMap(extractAdtOccurrence({ file: mod.relativePath, checker }))(
      mod.ir.typeDeclarations,
    );

const getAdtKey = (o: TaggedAdtOccurrence) => o.key;
const getAdtFile = (o: TaggedAdtOccurrence) => o.file;
const getAdtSymbol = (o: TaggedAdtOccurrence) => o.symbol;
const quoteSingle = (t: string) => `'${t}'`;
const toTagShape = (t: string) => `{ readonly _tag: '${t}' }`;

const buildAdtHint = (input: {
  readonly occs: RNEA.ReadonlyNonEmptyArray<TaggedAdtOccurrence>;
  readonly files: ReadonlyArray<string>;
  readonly idx: number;
}) => {
  const symbols = RA.uniq(S.Eq)(sortStrings(RA.map(getAdtSymbol)(input.occs)));
  const tags = input.occs[0].tags;
  const quotedTags = RA.map(quoteSingle)(tags).join(' | ');
  const tagShapes = RA.map(toTagShape)(tags).join(' | ');
  return {
    hintId: `missing-domain-model-adt-${input.idx + 1}`,
    category: 'missing-domain-model' as const,
    priority: 'high' as const,
    files: input.files,
    symbols,
    evidence: `Discriminated union with identical tag set (${quotedTags}) is redefined independently in ${input.files.length} modules: ${symbols.join(', ')}.`,
    suggestion:
      'Consolidate these repeated discriminated unions into a single canonical shared ADT (or parametric ADT like RemoteData<E, A> / AsyncState<E, A>) so exhaustive matchers and constructors are reused.',
    suggestedSignature: O.some(`export type SharedState<A, E = string> = ${tagShapes};`),
    researchQuestions: [
      `Are ${symbols.join(', ')} modeling the same lifecycle state machine across different entities?`,
    ],
  };
};

const toAdtHint =
  (input: { readonly dag: BuiltProjectDag; readonly minOcc: number }) =>
  (
    pair: readonly [
      readonly [string, RNEA.ReadonlyNonEmptyArray<TaggedAdtOccurrence>],
      number,
    ],
  ): O.Option<CrossFileHint> => {
    const [[, occs], idx] = pair;
    const files = RA.uniq(S.Eq)(sortStrings(RA.map(getAdtFile)(occs)));
    return B.match(
      () => O.none,
      () => O.some(buildAdtHint({ occs, files, idx })),
    )(files.length >= input.minOcc && involvesAnyTarget(input.dag)(files));
  };

const detectReinventedAdts = (input: MissingDomainModelInput) => {
  const occurrences = RA.chain(collectModuleAdtOccurrences(input.checker))(
    RA.filter(isNonBarrel)(Array.from(input.dag.modules.values())),
  );
  const grouped = RNEA.groupBy(getAdtKey)(occurrences);
  const entries = Object.entries(grouped);
  return RA.filterMap(toAdtHint({ dag: input.dag, minOcc: input.minOcc }))(
    RA.zip(RA.makeBy(entries.length, identityNum))(entries),
  );
};

const extractFieldPrimitiveOccurrence =
  (input: { readonly file: string; readonly typeName: string }) =>
  (field: IrFieldLike): O.Option<DomainPrimitiveOccurrence> => {
    const isEligible =
      (field.isRawString || field.isRawNumber) && isDomainPrimitiveFieldName(field.name);
    const prim = B.match(
      () => 'number' as const,
      () => 'string' as const,
    )(field.isRawString);
    return B.match(
      () => O.none,
      () =>
        O.some({
          key: `${field.name}:${prim}`,
          name: field.name,
          prim,
          file: input.file,
          typeName: input.typeName,
        }),
    )(isEligible);
  };

const extractDeclPrimitiveOccurrences =
  (file: string) =>
  (td: TypeDeclInfo): ReadonlyArray<DomainPrimitiveOccurrence> =>
    B.match(
      () => [],
      () => RA.filterMap(extractFieldPrimitiveOccurrence({ file, typeName: td.name }))(td.fields),
    )(!td.isNewtype);

const collectModulePrimitiveOccurrences = (mod: ResolvedModuleData) =>
  RA.chain(extractDeclPrimitiveOccurrences(mod.relativePath))(mod.ir.typeDeclarations);

const getPrimKey = (o: DomainPrimitiveOccurrence) => o.key;
const getPrimFile = (o: DomainPrimitiveOccurrence) => o.file;
const getPrimTypeName = (o: DomainPrimitiveOccurrence) => o.typeName;

const buildPrimitiveHint = (input: {
  readonly occs: RNEA.ReadonlyNonEmptyArray<DomainPrimitiveOccurrence>;
  readonly files: ReadonlyArray<string>;
}) => {
  const first = input.occs[0];
  const brandName = toPascalCase(first.name);
  const symbols = RA.uniq(S.Eq)(sortStrings(RA.map(getPrimTypeName)(input.occs)));
  return {
    hintId: `missing-domain-model-newtype-${first.name}`,
    category: 'missing-domain-model' as const,
    priority: 'medium' as const,
    files: input.files,
    symbols,
    evidence: `Raw primitive field "${first.name}: ${first.prim}" appears unbranded across ${input.files.length} modules (${input.files.join(', ')}).`,
    suggestion: `Extract a shared newtype-ts brand "${brandName}" in a domain primitives module so "${first.name}" values cannot be confused with arbitrary ${first.prim}s across modules.`,
    suggestedSignature: O.some(
      `export type ${brandName} = Newtype<{ readonly ${brandName}: unique symbol }, ${first.prim}>;`,
    ),
    researchQuestions: [
      `What validation invariant (Smart Constructor / Prism) should guard "${brandName}" at system boundaries?`,
    ],
  };
};

const toPrimitiveHint =
  (input: { readonly dag: BuiltProjectDag; readonly minOcc: number }) =>
  (
    entry: readonly [string, RNEA.ReadonlyNonEmptyArray<DomainPrimitiveOccurrence>],
  ): O.Option<CrossFileHint> => {
    const [, occs] = entry;
    const files = RA.uniq(S.Eq)(sortStrings(RA.map(getPrimFile)(occs)));
    return B.match(
      () => O.none,
      () => O.some(buildPrimitiveHint({ occs, files })),
    )(files.length >= input.minOcc && involvesAnyTarget(input.dag)(files));
  };

const detectRepeatedDomainPrimitives = (input: MissingDomainModelInput) => {
  const occurrences = RA.chain(collectModulePrimitiveOccurrences)(
    RA.filter(isNonBarrel)(Array.from(input.dag.modules.values())),
  );
  const grouped = RNEA.groupBy(getPrimKey)(occurrences);
  return RA.filterMap(toPrimitiveHint({ dag: input.dag, minOcc: input.minOcc }))(
    Object.entries(grouped),
  );
};

export const discoverMissingDomainModels = ((
  input: MissingDomainModelInput,
): ReadonlyArray<CrossFileHint> => [
  ...detectRepeatedFieldClusters(input),
  ...detectReinventedAdts(input),
  ...detectRepeatedDomainPrimitives(input),
]) satisfies (input: MissingDomainModelInput) => ReadonlyArray<CrossFileHint>;
