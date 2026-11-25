import * as B from 'fp-ts/lib/boolean.js';
import { constant, flow } from 'fp-ts/lib/function.js';
import * as O from 'fp-ts/lib/Option.js';
import * as RA from 'fp-ts/lib/ReadonlyArray.js';
import { Lens } from 'monocle-ts';
import type { AgentHint, FieldInfo, RuleContext, TypeDeclInfo } from '../model/report.js';

export type HintRunner = (ctx: RuleContext) => ReadonlyArray<AgentHint>;

type RawFieldSummary = {
  readonly td: TypeDeclInfo;
  readonly rawFields: ReadonlyArray<FieldInfo>;
};

type BrandCandidateInfo = {
  readonly td: TypeDeclInfo;
  readonly rawFields: ReadonlyArray<FieldInfo>;
  readonly hasMultipleSamePrimitive: boolean;
  readonly domainNamedPrimitives: ReadonlyArray<FieldInfo>;
};

type TargetFieldsInfo = {
  readonly info: BrandCandidateInfo;
  readonly targetFields: ReadonlyArray<FieldInfo>;
};

type BrandHintInput = {
  readonly td: TypeDeclInfo;
  readonly hasMultipleSamePrimitive: boolean;
  readonly targetFields: ReadonlyArray<FieldInfo>;
  readonly firstField: FieldInfo;
};

const lineLens = Lens.fromPath<TypeDeclInfo>()(['location', 'line']);
const columnLens = Lens.fromPath<TypeDeclInfo>()(['location', 'column']);
const typeDeclarationsLens = Lens.fromPath<RuleContext>()(['ir', 'typeDeclarations']);

const isNonEmptyString = (s: string) => s.length > 0;
const capitalizeNonEmpty = (s: string) => `${s.charAt(0).toUpperCase()}${s.slice(1)}`;

const toPascal = flow(
  O.fromPredicate(isNonEmptyString),
  O.map(capitalizeNonEmpty),
  O.getOrElse(constant('Brand')),
);

const isEligibleTypeDecl = (td: TypeDeclInfo) => td.isExported && !td.isNewtype;

const isRawPrimitiveField = (f: FieldInfo) =>
  (f.isRawString || f.isRawNumber) && f.name !== '_tag';

const isRawStringField = (f: FieldInfo) => f.isRawString;
const isRawNumberField = (f: FieldInfo) => f.isRawNumber;

const isDomainNamedField = (f: FieldInfo) =>
  /id$|email|price|amount|rate|currency|cents|percent|count|age|date|timestamp/i.test(f.name);

const formatFieldEvidence = (f: FieldInfo) => `${f.name}: ${f.typeText}`;

const hasMultipleSame = (rawFields: ReadonlyArray<FieldInfo>) =>
  RA.filter(isRawStringField)(rawFields).length >= 2 ||
  RA.filter(isRawNumberField)(rawFields).length >= 2;

const attachRawFields = (td: TypeDeclInfo) => ({
  td,
  rawFields: RA.filter(isRawPrimitiveField)(td.fields),
});

const attachBrandStats = ({ td, rawFields }: RawFieldSummary) => ({
  td,
  rawFields,
  hasMultipleSamePrimitive: hasMultipleSame(rawFields),
  domainNamedPrimitives: RA.filter(isDomainNamedField)(rawFields),
});

const hasBrandCandidate = (info: BrandCandidateInfo) =>
  info.hasMultipleSamePrimitive || RA.isNonEmpty(info.domainNamedPrimitives);

const selectTargetFields = (info: BrandCandidateInfo) =>
  flow(
    O.fromPredicate(RA.isNonEmpty<FieldInfo>),
    O.getOrElse(constant(info.rawFields)),
  )(info.domainNamedPrimitives);

const attachTargetFields = (info: BrandCandidateInfo) => ({
  info,
  targetFields: selectTargetFields(info),
});

const makeBrandHintInput =
  ({ info, targetFields }: TargetFieldsInfo) =>
  (firstField: FieldInfo): BrandHintInput => ({
    td: info.td,
    hasMultipleSamePrimitive: info.hasMultipleSamePrimitive,
    targetFields,
    firstField,
  });

const extractFirstField = (tf: TargetFieldsInfo) =>
  O.map(makeBrandHintInput(tf))(RA.head(tf.targetFields));

const resolveFirstField = flow(attachTargetFields, extractFirstField);

const toNewtypeBrandHint = ({
  td,
  hasMultipleSamePrimitive,
  targetFields,
  firstField,
}: BrandHintInput) => ({
  hintId: `newtype-brand-${td.name}`,
  category: 'newtype-brand' as const,
  priority: B.match(constant('medium' as const), constant('high' as const))(hasMultipleSamePrimitive),
  location: { line: lineLens.get(td), column: columnLens.get(td) },
  evidence: `Exported type \`${td.name}\` uses raw primitive(s): ${RA.map(formatFieldEvidence)(targetFields).join(', ')}.`,
  suggestion:
    'Introduce `newtype-ts` branded types for domain quantities/identifiers and wrap/unwrap them with `iso<T>()` or `prism<T>(predicate)` in point-free `flow`.',
  suggestedSignature: O.some(
    `export type ${toPascal(firstField.name)} = Newtype<{ readonly ${toPascal(firstField.name)}: unique symbol }, ${B.match(constant('string'), constant('number'))(firstField.isRawNumber)}>;`,
  ),
  researchQuestions: [
    `What invariant (e.g., non-empty, positive, regex) must \`${firstField.name}\` satisfy to be valid?`,
    'Are there other modules that pass these primitives where swapping two arguments could cause a silent bug?',
  ],
});

const checkTypeForRawPrimitives = flow(
  attachRawFields,
  attachBrandStats,
  O.fromPredicate(hasBrandCandidate),
  O.chain(resolveFirstField),
  O.map(toNewtypeBrandHint),
  O.match(RA.zero<AgentHint>, RA.of),
);

const runNewtypeBrandHints = flow(
  typeDeclarationsLens.get,
  RA.filter(isEligibleTypeDecl),
  RA.chain(checkTypeForRawPrimitives),
);

const identityCtx = (ctx: RuleContext) => ctx;

export const detectNewtypeBrandHints = flow(
  identityCtx,
  runNewtypeBrandHints,
) satisfies HintRunner;


