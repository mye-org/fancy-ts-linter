import * as B from 'fp-ts/lib/boolean.js';
import { constant } from 'fp-ts/lib/function.js';
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
import type { BindingInfo, TypeDeclInfo } from '../model/report.js';

export type GenericAbstractionInput = {
  readonly dag: BuiltProjectDag;
  readonly checker: ts.TypeChecker;
  readonly minOcc: number;
};

type TypeclassPatternKind = 'Semigroup/Monoid' | 'Eq' | 'Ord';

type TypeclassMatch = {
  readonly kind: TypeclassPatternKind;
  readonly concreteType: string;
};

type SkeletonOccurrence = {
  readonly skeleton: string;
  readonly file: string;
  readonly typeName: string;
  readonly concreteKey: string;
};

type TypeclassOccurrence = {
  readonly kind: TypeclassPatternKind;
  readonly file: string;
  readonly symbol: string;
  readonly concreteType: string;
};

type NamedField = {
  readonly name: string;
  readonly typeText: string;
};

const sortStrings = RA.sortBy([S.Ord]);
const identityNum = (i: number) => i;
const inSet = (set: ReadonlySet<string>) => (value: string) => set.has(value);

const isPrimitiveOrStdType = (name: string) =>
  new Set([
    'string',
    'number',
    'boolean',
    'bigint',
    'symbol',
    'unknown',
    'never',
    'void',
    'null',
    'undefined',
    'Date',
    'RegExp',
    'Error',
    'Array',
    'ReadonlyArray',
    'Record',
    'Map',
    'Set',
    'Option',
    'Either',
    'Task',
    'TaskEither',
    'Reader',
    'ReaderTask',
    'ReaderTaskEither',
    'IO',
    'State',
    'Promise',
    'Newtype',
  ]).has(name);

const normalizeTypeText = (raw: string) =>
  raw.replace(/\s+/g, ' ').replace(/\breadonly\s+/g, '').trim();

const isNonBarrel = (mod: ResolvedModuleData) => !mod.isBarrel;
const isTargetModule = (mod: ResolvedModuleData) => mod.isTarget;
const getRelativePath = (mod: ResolvedModuleData) => mod.relativePath;

const involvesAnyTarget = (dag: BuiltProjectDag) => (files: ReadonlyArray<string>) => {
  const targetFiles = new Set(
    RA.map(getRelativePath)(RA.filter(isTargetModule)(Array.from(dag.modules.values()))),
  );
  return RA.some(inSet(targetFiles))(files);
};

const matchArrayToStrings = (m: RegExpMatchArray) => Array.from(m);

const matchCapIdents = (t: string) =>
  O.getOrElse(constant<ReadonlyArray<string>>([]))(
    O.map(matchArrayToStrings)(
      O.fromNullable(t.match(/\b[A-Z][a-zA-Z0-9_]*\b/g)),
    ),
  );

const isDomainIdentInSet = (domainTypes: ReadonlySet<string>) => (ident: string) =>
  !isPrimitiveOrStdType(ident) && domainTypes.has(ident);

const collectIdentOrder = (input: {
  readonly texts: ReadonlyArray<string>;
  readonly domainTypes: ReadonlySet<string>;
}) =>
  RA.uniq(S.Eq)(
    RA.filter(isDomainIdentInSet(input.domainTypes))(
      RA.chain(matchCapIdents)(input.texts),
    ),
  );

const replaceIdentToken =
  (orderedIdents: ReadonlyArray<string>) =>
  (ident: string) => {
    const idx = orderedIdents.indexOf(ident);
    return B.match(
      () => ident,
      () => `T${idx}`,
    )(idx >= 0);
  };

const replaceDomainIdents =
  (orderedIdents: ReadonlyArray<string>) =>
  (raw: string) =>
    normalizeTypeText(raw).replace(/\b[A-Z][a-zA-Z0-9_]*\b/g, replaceIdentToken(orderedIdents));

const getDeclName = (td: TypeDeclInfo) => td.name;
const getReferencedDomainTypes = (m: ResolvedModuleData) => m.referencedDomainTypes;
const getDeclNames = (m: ResolvedModuleData) => RA.map(getDeclName)(m.ir.typeDeclarations);

const collectAllDomainTypes = (dag: BuiltProjectDag) => {
  const mods = Array.from(dag.modules.values());
  return new Set([
    ...RA.chain(getReferencedDomainTypes)(mods),
    ...RA.chain(getDeclNames)(mods),
  ]);
};

const getNamedFieldName = (f: NamedField) => f.name;
const getNamedFieldTypeText = (f: NamedField) => normalizeTypeText(f.typeText);
const byNamedFieldName = Ord.contramap(getNamedFieldName)(S.Ord);
const sortFieldsByName = RA.sortBy([byNamedFieldName]);

const formatParamField =
  (orderedIdents: ReadonlyArray<string>) =>
  (f: NamedField) =>
    `readonly ${f.name}: ${replaceDomainIdents(orderedIdents)(f.typeText)}`;

const buildSkeletonOccurrence = (input: {
  readonly file: string;
  readonly typeName: string;
  readonly sortedFields: ReadonlyArray<NamedField>;
  readonly orderedIdents: ReadonlyArray<string>;
}) => ({
  skeleton: `{ ${RA.map(formatParamField(input.orderedIdents))(input.sortedFields).join('; ')} }`,
  file: input.file,
  typeName: input.typeName,
  concreteKey: input.orderedIdents.join(','),
});

const tryBuildSkeleton = (input: {
  readonly file: string;
  readonly domainTypes: ReadonlySet<string>;
  readonly td: TypeDeclInfo;
}): O.Option<SkeletonOccurrence> => {
  const sortedFields = sortFieldsByName(input.td.fields);
  const orderedIdents = collectIdentOrder({
    texts: RA.map(getNamedFieldTypeText)(sortedFields),
    domainTypes: input.domainTypes,
  });
  return B.match(
    () => O.none,
    () =>
      O.some(
        buildSkeletonOccurrence({
          file: input.file,
          typeName: input.td.name,
          sortedFields,
          orderedIdents,
        }),
      ),
  )(orderedIdents.length > 0);
};

const hasNonEmptyTypeParams = (tp: ts.NodeArray<ts.TypeParameterDeclaration>) => tp.length > 0;

const extractSkeletonOccurrence =
  (input: { readonly file: string; readonly domainTypes: ReadonlySet<string> }) =>
  (td: TypeDeclInfo): O.Option<SkeletonOccurrence> => {
    const hasTypeParams = O.exists(hasNonEmptyTypeParams)(
      O.fromNullable(td.node.typeParameters),
    );
    const eligible =
      !td.isNewtype && !td.isDiscriminatedUnion && td.fields.length >= 2 && !hasTypeParams;
    return B.match(
      () => O.none,
      () => tryBuildSkeleton({ file: input.file, domainTypes: input.domainTypes, td }),
    )(eligible);
  };

const collectModuleSkeletons =
  (domainTypes: ReadonlySet<string>) =>
  (mod: ResolvedModuleData) =>
    RA.filterMap(extractSkeletonOccurrence({ file: mod.relativePath, domainTypes }))(
      mod.ir.typeDeclarations,
    );

const getSkeletonKey = (s: SkeletonOccurrence) => s.skeleton;
const getSkeletonFile = (s: SkeletonOccurrence) => s.file;
const getSkeletonTypeName = (s: SkeletonOccurrence) => s.typeName;
const getSkeletonConcrete = (s: SkeletonOccurrence) => s.concreteKey;

const buildGenericDataTypeHint = (input: {
  readonly skeleton: string;
  readonly occs: RNEA.ReadonlyNonEmptyArray<SkeletonOccurrence>;
  readonly files: ReadonlyArray<string>;
  readonly concreteList: ReadonlyArray<string>;
  readonly idx: number;
}) => {
  const typeList = RA.uniq(S.Eq)(sortStrings(RA.map(getSkeletonTypeName)(input.occs)));
  const typeParams = B.match(
    () => '<T0>',
    () => '<T0, T1>',
  )(input.skeleton.includes('T1'));
  return {
    hintId: `generic-datatype-${input.idx + 1}`,
    category: 'generic-abstraction' as const,
    priority: 'high' as const,
    files: input.files,
    symbols: typeList,
    evidence: `${typeList.length} monomorphic types (${typeList.join(', ')}) across ${input.files.length} modules share the exact parameterized structure ${input.skeleton} instantiated over different concrete types (${input.concreteList.join(', ')}).`,
    suggestion: `Replace these monomorphic wrappers with a single parametric generic data type (e.g. GenericContainer${typeParams}) and reuse polymorphic operations over it.`,
    suggestedSignature: O.some(`export type GenericContainer${typeParams} = ${input.skeleton};`),
    researchQuestions: [
      `Can ${typeList.join(', ')} be unified into one parametric type (e.g., Paginated<T>, Envelope<T>, ResultPage<T>) with shared Functor/map helpers?`,
    ],
  };
};

const toGenericDataTypeHint =
  (input: { readonly dag: BuiltProjectDag; readonly minOcc: number }) =>
  (
    pair: readonly [readonly [string, RNEA.ReadonlyNonEmptyArray<SkeletonOccurrence>], number],
  ): O.Option<CrossFileHint> => {
    const [[skeleton, occs], idx] = pair;
    const files = RA.uniq(S.Eq)(sortStrings(RA.map(getSkeletonFile)(occs)));
    const concreteList = RA.uniq(S.Eq)(sortStrings(RA.map(getSkeletonConcrete)(occs)));
    return B.match(
      () => O.none,
      () =>
        O.some(
          buildGenericDataTypeHint({ skeleton, occs, files, concreteList, idx }),
        ),
    )(
      files.length >= input.minOcc &&
        concreteList.length >= input.minOcc &&
        involvesAnyTarget(input.dag)(files),
    );
  };

const detectGenericDataTypes = (input: GenericAbstractionInput) => {
  const domainTypes = collectAllDomainTypes(input.dag);
  const occurrences = RA.chain(collectModuleSkeletons(domainTypes))(
    RA.filter(isNonBarrel)(Array.from(input.dag.modules.values())),
  );
  const grouped = RNEA.groupBy(getSkeletonKey)(occurrences);
  const entries = Object.entries(grouped);
  return RA.filterMap(toGenericDataTypeHint({ dag: input.dag, minOcc: input.minOcc }))(
    RA.zip(RA.makeBy(entries.length, identityNum))(entries),
  );
};

const formatSymbolProp =
  (input: { readonly checker: ts.TypeChecker; readonly location: ts.Node }) =>
  (p: ts.Symbol) => {
    const pt = normalizeTypeText(
      input.checker.typeToString(
        input.checker.getTypeOfSymbolAtLocation(p, input.location),
      ),
    );
    return `${p.getName()}:${pt}`;
  };

const getStructuralShapeKey = (input: {
  readonly checker: ts.TypeChecker;
  readonly type: ts.Type;
  readonly location: ts.Node;
}) => {
  const props = input.type.getProperties();
  return B.match(
    () => normalizeTypeText(input.checker.typeToString(input.type)),
    () =>
      sortStrings(
        RA.map(formatSymbolProp({ checker: input.checker, location: input.location }))(
          props,
        ),
      ).join(';'),
  )(props.length > 0 && input.type.getCallSignatures().length === 0);
};

const compareByShapeKey = (input: {
  readonly checker: ts.TypeChecker;
  readonly a: ts.Type;
  readonly b: ts.Type;
  readonly location: ts.Node;
}) => {
  const sa = normalizeTypeText(input.checker.typeToString(input.a));
  const sb = normalizeTypeText(input.checker.typeToString(input.b));
  return B.match(
    () =>
      getStructuralShapeKey({
        checker: input.checker,
        type: input.a,
        location: input.location,
      }) ===
      getStructuralShapeKey({
        checker: input.checker,
        type: input.b,
        location: input.location,
      }),
    () => true,
  )(sa === sb);
};

const areTypesStructurallyEquivalent = (input: {
  readonly checker: ts.TypeChecker;
  readonly a: ts.Type;
  readonly b: ts.Type;
  readonly location: ts.Node;
}) =>
  B.match(
    () => compareByShapeKey(input),
    () => true,
  )(input.a === input.b);

const classifyBinaryTypeclass = (input: {
  readonly checker: ts.TypeChecker;
  readonly lhsType: ts.Type;
  readonly rhsType: ts.Type;
  readonly retType: ts.Type;
  readonly location: ts.Node;
}): O.Option<TypeclassMatch> => {
  const t0Str = normalizeTypeText(input.checker.typeToString(input.lhsType));
  const retStr = normalizeTypeText(input.checker.typeToString(input.retType));
  const sameInputs =
    !isPrimitiveOrStdType(t0Str) &&
    areTypesStructurallyEquivalent({
      checker: input.checker,
      a: input.lhsType,
      b: input.rhsType,
      location: input.location,
    });
  return B.match(
    () => O.none,
    () =>
      B.match(
        () =>
          B.match(
            () =>
              B.match(
                () => O.none,
                () => O.some<TypeclassMatch>({ kind: 'Ord', concreteType: t0Str }),
              )(retStr === 'Ordering' || retStr === '-1 | 0 | 1'),
            () => O.some<TypeclassMatch>({ kind: 'Eq', concreteType: t0Str }),
          )(retStr === 'boolean'),
        () => O.some<TypeclassMatch>({ kind: 'Semigroup/Monoid', concreteType: t0Str }),
      )(
        areTypesStructurallyEquivalent({
          checker: input.checker,
          a: input.lhsType,
          b: input.retType,
          location: input.location,
        }),
      ),
  )(sameInputs);
};

const singleElementHead = <A>(arr: ReadonlyArray<A>) =>
  B.match(
    () => O.none,
    () => RA.head(arr),
  )(arr.length === 1);

const matchCurriedInnerParam =
  (input: {
    readonly checker: ts.TypeChecker;
    readonly p0Type: ts.Type;
    readonly declaration: ts.Node;
    readonly innerSig: ts.Signature;
  }) =>
  (p1: ts.Symbol) =>
    classifyBinaryTypeclass({
      checker: input.checker,
      lhsType: input.p0Type,
      rhsType: input.checker.getTypeOfSymbol(p1),
      retType: input.innerSig.getReturnType(),
      location: input.declaration,
    });

const matchCurriedInnerSig =
  (input: {
    readonly checker: ts.TypeChecker;
    readonly p0Type: ts.Type;
    readonly declaration: ts.Node;
  }) =>
  (innerSig: ts.Signature) =>
    O.chain(
      matchCurriedInnerParam({
        checker: input.checker,
        p0Type: input.p0Type,
        declaration: input.declaration,
        innerSig,
      }),
    )(singleElementHead(innerSig.getParameters()));

const matchCurriedTypeclass = (input: {
  readonly checker: ts.TypeChecker;
  readonly p0Type: ts.Type;
  readonly retType: ts.Type;
  readonly declaration: ts.Node;
}) =>
  O.chain(
    matchCurriedInnerSig({
      checker: input.checker,
      p0Type: input.p0Type,
      declaration: input.declaration,
    }),
  )(singleElementHead(input.retType.getCallSignatures()));

const matchPairSecondProp =
  (input: {
    readonly checker: ts.TypeChecker;
    readonly prop0: ts.Symbol;
    readonly retType: ts.Type;
    readonly declaration: ts.Node;
  }) =>
  (prop1: ts.Symbol) =>
    classifyBinaryTypeclass({
      checker: input.checker,
      lhsType: input.checker.getTypeOfSymbolAtLocation(input.prop0, input.declaration),
      rhsType: input.checker.getTypeOfSymbolAtLocation(prop1, input.declaration),
      retType: input.retType,
      location: input.declaration,
    });

const matchPairFirstProp =
  (input: {
    readonly checker: ts.TypeChecker;
    readonly props: ReadonlyArray<ts.Symbol>;
    readonly retType: ts.Type;
    readonly declaration: ts.Node;
  }) =>
  (prop0: ts.Symbol) =>
    O.chain(
      matchPairSecondProp({
        checker: input.checker,
        prop0,
        retType: input.retType,
        declaration: input.declaration,
      }),
    )(RA.lookup(1)(input.props));

const matchPairRecordTypeclass = (input: {
  readonly checker: ts.TypeChecker;
  readonly p0Type: ts.Type;
  readonly retType: ts.Type;
  readonly declaration: ts.Node;
}) => {
  const props = input.p0Type.getProperties();
  return B.match(
    () => O.none,
    () =>
      O.chain(
        matchPairFirstProp({
          checker: input.checker,
          props,
          retType: input.retType,
          declaration: input.declaration,
        }),
      )(RA.head(props)),
  )(props.length === 2);
};

const toTypeclassOccurrence =
  (input: { readonly file: string; readonly symbol: string }) =>
  (res: TypeclassMatch): TypeclassOccurrence => ({
    kind: res.kind,
    file: input.file,
    symbol: input.symbol,
    concreteType: res.concreteType,
  });

const matchPrimaryParam =
  (input: {
    readonly checker: ts.TypeChecker;
    readonly relativePath: string;
    readonly primary: BindingInfo;
    readonly retType: ts.Type;
  }) =>
  (p0: ts.Symbol): O.Option<TypeclassOccurrence> => {
    const p0Type = input.checker.getTypeOfSymbol(p0);
    const curriedMatch = matchCurriedTypeclass({
      checker: input.checker,
      p0Type,
      retType: input.retType,
      declaration: input.primary.declaration,
    });
    const pairMatch = matchPairRecordTypeclass({
      checker: input.checker,
      p0Type,
      retType: input.retType,
      declaration: input.primary.declaration,
    });
    return O.map(
      toTypeclassOccurrence({ file: input.relativePath, symbol: input.primary.name }),
    )(RA.head(RA.compact([curriedMatch, pairMatch])));
  };

const matchPrimarySig =
  (input: {
    readonly checker: ts.TypeChecker;
    readonly relativePath: string;
    readonly primary: BindingInfo;
  }) =>
  (sig: ts.Signature): O.Option<TypeclassOccurrence> =>
    O.chain(
      matchPrimaryParam({
        checker: input.checker,
        relativePath: input.relativePath,
        primary: input.primary,
        retType: sig.getReturnType(),
      }),
    )(singleElementHead(sig.getParameters()));

const analyzePrimaryBinding =
  (input: { readonly checker: ts.TypeChecker; readonly relativePath: string }) =>
  (primary: BindingInfo): O.Option<TypeclassOccurrence> =>
    O.chain(
      matchPrimarySig({
        checker: input.checker,
        relativePath: input.relativePath,
        primary,
      }),
    )(singleElementHead(input.checker.getTypeAtLocation(primary.declaration).getCallSignatures()));

const isPrimaryTypeclassCandidate = (b: BindingInfo) =>
  b.isExported && b.kind !== 'other' && b.kind !== 'typeclass-instance';

const analyzeModuleTypeclass =
  (checker: ts.TypeChecker) =>
  (mod: ResolvedModuleData): O.Option<TypeclassOccurrence> => {
    const eligible =
      !mod.isBarrel && !mod.isTypeOnlyModule && O.isSome(mod.exportedFunction);
    return B.match(
      () => O.none,
      () =>
        O.chain(analyzePrimaryBinding({ checker, relativePath: mod.relativePath }))(
          RA.findFirst(isPrimaryTypeclassCandidate)(mod.ir.bindings),
        ),
    )(eligible);
  };

const typeclassSigSuggestion = (kind: TypeclassPatternKind) =>
  B.match(
    () =>
      B.match(
        () => "import * as Ord from 'fp-ts/Ord'; // Ord.contramap(...)(baseOrd)",
        () => "import * as Eq from 'fp-ts/Eq'; // Eq.struct({ ... })",
      )(kind === 'Eq'),
    () => "import * as M from 'fp-ts/Monoid'; // M.struct({ ... }) & M.concatAll(monoid)",
  )(kind === 'Semigroup/Monoid');

const getOccKind = (o: TypeclassOccurrence) => o.kind;
const getOccFile = (o: TypeclassOccurrence) => o.file;
const getOccSymbol = (o: TypeclassOccurrence) => o.symbol;
const getOccConcreteType = (o: TypeclassOccurrence) => o.concreteType;

const buildTypeclassHint = (input: {
  readonly kind: TypeclassPatternKind;
  readonly occs: RNEA.ReadonlyNonEmptyArray<TypeclassOccurrence>;
  readonly files: ReadonlyArray<string>;
  readonly types: ReadonlyArray<string>;
}) => {
  const symbols = RA.uniq(S.Eq)(sortStrings(RA.map(getOccSymbol)(input.occs)));
  return {
    hintId: `generic-typeclass-${input.kind.toLowerCase().replace(/[^a-z]/g, '-')}`,
    category: 'generic-abstraction' as const,
    priority: 'medium' as const,
    files: input.files,
    symbols,
    evidence: `${symbols.length} modules (${symbols.join(', ')}) implement ad-hoc ${input.kind} operations across different domain types (${input.types.join(', ')}).`,
    suggestion: `Model these as standard fp-ts ${input.kind} typeclass instances so they compose automatically with fp-ts combinators (struct, concatAll, uniq, sort, contramap).`,
    suggestedSignature: O.some(typeclassSigSuggestion(input.kind)),
    researchQuestions: [
      `Are these ${input.kind} operations associative/lawful enough to be derived via fp-ts ${input.kind} combinators?`,
    ],
  };
};

const toTypeclassHint =
  (input: { readonly dag: BuiltProjectDag; readonly minOcc: number }) =>
  (
    entry: readonly [string, RNEA.ReadonlyNonEmptyArray<TypeclassOccurrence>],
  ): O.Option<CrossFileHint> => {
    const [, occs] = entry;
    const kind = occs[0].kind;
    const files = RA.uniq(S.Eq)(sortStrings(RA.map(getOccFile)(occs)));
    const types = RA.uniq(S.Eq)(sortStrings(RA.map(getOccConcreteType)(occs)));
    return B.match(
      () => O.none,
      () => O.some(buildTypeclassHint({ kind, occs, files, types })),
    )(
      files.length >= input.minOcc &&
        types.length >= input.minOcc &&
        involvesAnyTarget(input.dag)(files),
    );
  };

const detectFpTypeclassOpportunities = (input: GenericAbstractionInput) => {
  const occurrences = RA.filterMap(analyzeModuleTypeclass(input.checker))(
    Array.from(input.dag.modules.values()),
  );
  const grouped = RNEA.groupBy(getOccKind)(occurrences);
  return RA.filterMap(toTypeclassHint({ dag: input.dag, minOcc: input.minOcc }))(
    Object.entries(grouped),
  );
};

export const discoverGenericAbstractions = (({
  dag,
  checker,
  minOcc,
}: GenericAbstractionInput): ReadonlyArray<CrossFileHint> => [
  ...detectGenericDataTypes({ dag, checker, minOcc }),
  ...detectFpTypeclassOpportunities({ dag, checker, minOcc }),
]) satisfies (input: GenericAbstractionInput) => ReadonlyArray<CrossFileHint>;
