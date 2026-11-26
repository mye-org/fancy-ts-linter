import * as B from 'fp-ts/lib/boolean.js';
import * as O from 'fp-ts/lib/Option.js';
import * as RA from 'fp-ts/lib/ReadonlyArray.js';
import type { AgentHint, FieldInfo, RuleContext, TypeDeclInfo } from '../model/report.js';

export type HintRunner = (ctx: RuleContext) => ReadonlyArray<AgentHint>;

const toPascal = (s: string) =>
  B.match(
    () => `${s.charAt(0).toUpperCase()}${s.slice(1)}`,
    () => 'Brand',
  )(s.length === 0);

const isRawPrimitiveField = (f: FieldInfo) =>
  (f.isRawString || f.isRawNumber) && f.name !== '_tag';

const isRawStringField = (f: FieldInfo) => f.isRawString;

const isRawNumberField = (f: FieldInfo) => f.isRawNumber;

const isDomainNamedPrimitive = (f: FieldInfo) =>
  /id$|email|price|amount|rate|currency|cents|percent|count|age|date|timestamp/i.test(f.name);

const formatFieldType = (f: FieldInfo) => `${f.name}: ${f.typeText}`;

type NewtypeHintInput = {
  readonly td: TypeDeclInfo;
  readonly targetFields: ReadonlyArray<FieldInfo>;
  readonly hasMultipleSamePrimitive: boolean;
};

const buildNewtypeHint =
  ({ td, targetFields, hasMultipleSamePrimitive }: NewtypeHintInput) =>
  (firstField: FieldInfo): ReadonlyArray<AgentHint> => {
    const baseType = B.match(
      () => 'string',
      () => 'number',
    )(firstField.isRawNumber);
    const brandName = toPascal(firstField.name);
    const priority = B.match<'medium' | 'high'>(
      () => 'medium',
      () => 'high',
    )(hasMultipleSamePrimitive);

    return [
      {
        hintId: `newtype-brand-${td.name}`,
        category: 'newtype-brand',
        priority,
        location: { line: td.location.line, column: td.location.column },
        evidence: `Exported type \`${td.name}\` uses raw primitive(s): ${RA.map(formatFieldType)(targetFields).join(', ')}.`,
        suggestion: `Introduce \`newtype-ts\` branded types for domain quantities/identifiers and wrap/unwrap them with \`iso<T>()\` or \`prism<T>(predicate)\` in point-free \`flow\`.`,
        suggestedSignature: O.some(
          `export type ${brandName} = Newtype<{ readonly ${brandName}: unique symbol }, ${baseType}>;`,
        ),
        researchQuestions: [
          `What invariant (e.g., non-empty, positive, regex) must \`${firstField.name}\` satisfy to be valid?`,
          'Are there other modules that pass these primitives where swapping two arguments could cause a silent bug?',
        ],
      },
    ];
  };

const analyzeExportedType = (td: TypeDeclInfo) => {
  const rawFields = RA.filter(isRawPrimitiveField)(td.fields);
  const hasMultipleSamePrimitive =
    RA.filter(isRawStringField)(rawFields).length >= 2 ||
    RA.filter(isRawNumberField)(rawFields).length >= 2;
  const domainNamedPrimitives = RA.filter(isDomainNamedPrimitive)(rawFields);
  const targetFields = B.match(
    () => rawFields,
    () => domainNamedPrimitives,
  )(RA.isNonEmpty(domainNamedPrimitives));

  return B.match<ReadonlyArray<AgentHint>>(
    () =>
      O.match<FieldInfo, ReadonlyArray<AgentHint>>(
        () => [],
        buildNewtypeHint({ td, targetFields, hasMultipleSamePrimitive }),
      )(RA.head(targetFields)),
    () => [],
  )(!hasMultipleSamePrimitive && RA.isEmpty(domainNamedPrimitives));
};

const checkTypeForRawPrimitives = (td: TypeDeclInfo) =>
  B.match<ReadonlyArray<AgentHint>>(
    () => [],
    () => analyzeExportedType(td),
  )(td.isExported && !td.isNewtype);

export const detectNewtypeBrandHints = ((ctx: RuleContext): ReadonlyArray<AgentHint> =>
  RA.chain(checkTypeForRawPrimitives)(ctx.ir.typeDeclarations)) satisfies HintRunner;
