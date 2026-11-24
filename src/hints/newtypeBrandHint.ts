import { flow } from 'fp-ts/lib/function.js';
import * as O from 'fp-ts/lib/Option.js';
import * as RA from 'fp-ts/lib/ReadonlyArray.js';
import type { AgentHint, FieldInfo, RuleContext, TypeDeclInfo } from '../model/report.js';

export type HintRunner = (ctx: RuleContext) => ReadonlyArray<AgentHint>;

const toPascal = (s: string): string =>
  s.length === 0 ? 'Brand' : `${s.charAt(0).toUpperCase()}${s.slice(1)}`;

const checkTypeForRawPrimitives = (td: TypeDeclInfo): ReadonlyArray<AgentHint> => {
  if (!td.isExported || td.isNewtype) {
    return [];
  }
  const rawFields = RA.filter(
    (f: FieldInfo) => (f.isRawString || f.isRawNumber) && f.name !== '_tag',
  )(td.fields);

  const hasMultipleSamePrimitive =
    RA.filter((f: FieldInfo) => f.isRawString)(rawFields).length >= 2 ||
    RA.filter((f: FieldInfo) => f.isRawNumber)(rawFields).length >= 2;

  const domainNamedPrimitives = RA.filter((f: FieldInfo) =>
    /id$|email|price|amount|rate|currency|cents|percent|count|age|date|timestamp/i.test(f.name),
  )(rawFields);

  if (!hasMultipleSamePrimitive && RA.isEmpty(domainNamedPrimitives)) {
    return [];
  }

  const targetFields = RA.isNonEmpty(domainNamedPrimitives) ? domainNamedPrimitives : rawFields;
  const firstField = targetFields[0];
  if (firstField === undefined) {
    return [];
  }
  const baseType = firstField.isRawNumber ? 'number' : 'string';
  const brandName = toPascal(firstField.name);

  return [
    {
      hintId: `newtype-brand-${td.name}`,
      category: 'newtype-brand',
      priority: hasMultipleSamePrimitive ? 'high' : 'medium',
      location: { line: td.location.line, column: td.location.column },
      evidence: `Exported type \`${td.name}\` uses raw primitive(s): ${RA.map((f: FieldInfo) => `${f.name}: ${f.typeText}`)(targetFields).join(', ')}.`,
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

const runNewtypeBrandHints = (ctx: RuleContext): ReadonlyArray<AgentHint> =>
  RA.chain(checkTypeForRawPrimitives)(ctx.ir.typeDeclarations);

const identityCtx = (ctx: RuleContext) => ctx;

export const detectNewtypeBrandHints = flow(
  identityCtx,
  runNewtypeBrandHints,
) satisfies HintRunner;
