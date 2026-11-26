import * as O from 'fp-ts/lib/Option.js';
import * as ts from 'typescript';
import type {
  BuiltProjectDag,
  CrossFileHint,
  ResolvedModuleData,
} from '../model/projectReport.js';
import type { TypeInspector } from '../model/report.js';

export type PatternDiscoveryOptions = {
  readonly minPatternOccurrences: number;
};

const GENERIC_FIELD_NAMES = new Set([
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
]);

const DOMAIN_PRIMITIVE_FIELD_RE =
  /(?:Id|Uuid|Email|Currency|Code|Amount|Price|Subtotal|Total|Cents|Url|Uri|Token|Phone|Slug|IsoDate|Timestamp|Percent|Rate|Zip|Tenant|AccountKey|Hash|Signature)$/i;

const ENV_FIELD_NAMES = new Set([
  'db',
  'database',
  'repo',
  'repository',
  'logger',
  'log',
  'config',
  'cfg',
  'env',
  'ctx',
  'context',
  'client',
  'http',
  'httpClient',
  'clock',
  'cache',
  'mailer',
  'storage',
  'gateway',
  'deps',
  'dependencies',
  'tracer',
  'metrics',
]);

const ENV_TYPE_NAME_RE = /(?:Env|Deps|Dependencies|Context|Config|Client|Repository|Repo|Logger|Clock|Gateway|Service|Store|Adapter)$/;

const PRIMITIVE_AND_STD_TYPES = new Set([
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
]);

const FP_NAMESPACE_METHODS = new Set([
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
]);

const involvesAnyTarget = (
  files: ReadonlyArray<string>,
  dag: BuiltProjectDag,
): boolean =>
  files.some((rel) => {
    for (const mod of dag.modules.values()) {
      if (mod.relativePath === rel && mod.isTarget) {
        return true;
      }
    }
    return false;
  });

const normalizeTypeText = (raw: string): string =>
  raw
    .replace(/\s+/g, ' ')
    .replace(/\breadonly\s+/g, '')
    .trim();

const toPascalCase = (s: string): string =>
  s
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .map((p) => (p.length > 0 ? p[0]!.toUpperCase() + p.slice(1) : ''))
    .join('');

const isEffectfulIo = (effects: ReadonlyArray<string>): boolean =>
  effects.some((e) =>
    e === 'Task' || e === 'TaskEither' || e === 'ReaderTask' || e === 'ReaderTaskEither' || e === 'IO',
  );

// ============================================================================
// Family 1: Missing Domain Models & Structural Type Duplication
// ============================================================================

type ObjectShapeRecord = {
  readonly file: string;
  readonly typeName: string;
  readonly fields: ReadonlyArray<{ readonly key: string; readonly name: string; readonly typeText: string }>;
};

const collectObjectShapes = (
  dag: BuiltProjectDag,
  checker: ts.TypeChecker,
): ReadonlyArray<ObjectShapeRecord> => {
  const shapes: ObjectShapeRecord[] = [];

  for (const mod of dag.modules.values()) {
    if (mod.isBarrel) {
      continue;
    }

    for (const td of mod.ir.typeDeclarations) {
      if (td.isNewtype || td.isDiscriminatedUnion || td.fields.length < 2) {
        continue;
      }
      const fields = td.fields
        .map((f) => ({
          name: f.name,
          typeText: normalizeTypeText(f.typeText),
          key: `${f.name}:${normalizeTypeText(f.typeText)}`,
        }))
        .sort((a, b) => a.key.localeCompare(b.key));
      shapes.push({ file: mod.relativePath, typeName: td.name, fields });
    }

    // Also inspect inline TypeLiteralNodes in parameter annotations
    const visit = (node: ts.Node): void => {
      if (ts.isTypeLiteralNode(node) && !ts.isTypeAliasDeclaration(node.parent)) {
        const type = checker.getTypeAtLocation(node);
        const props = type.getProperties();
        if (props.length >= 2) {
          const fields = props
            .map((p) => {
              const pt = normalizeTypeText(checker.typeToString(checker.getTypeOfSymbolAtLocation(p, node)));
              return { name: p.getName(), typeText: pt, key: `${p.getName()}:${pt}` };
            })
            .sort((a, b) => a.key.localeCompare(b.key));
          shapes.push({ file: mod.relativePath, typeName: '(inline)', fields });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(mod.sourceFile);
  }

  return shapes;
};

const detectRepeatedFieldClusters = (
  dag: BuiltProjectDag,
  checker: ts.TypeChecker,
  minOcc: number,
): ReadonlyArray<CrossFileHint> => {
  const shapes = collectObjectShapes(dag, checker);
  // Map field key -> set of files where it appears
  const fieldToFiles = new Map<string, Set<string>>();
  for (const s of shapes) {
    for (const f of s.fields) {
      let set = fieldToFiles.get(f.key);
      if (set === undefined) {
        set = new Set();
        fieldToFiles.set(f.key, set);
      }
      set.add(s.file);
    }
  }

  // Keep only fields occurring in >= minOcc distinct files
  const frequentFields = new Set<string>();
  for (const [k, files] of fieldToFiles.entries()) {
    if (files.size >= minOcc) {
      frequentFields.add(k);
    }
  }
  if (frequentFields.size < 2) {
    return [];
  }

  // For each pair of shapes from different files, compute their shared frequent field subset
  const candidateClusters = new Map<string, { keys: ReadonlyArray<string>; files: Set<string>; types: Set<string> }>();

  const perFileFiltered = shapes
    .map((s) => ({
      file: s.file,
      typeName: s.typeName,
      keys: s.fields.map((f) => f.key).filter((k) => frequentFields.has(k)),
    }))
    .filter((s) => s.keys.length >= 2);

  const targetRelFiles = new Set(
    Array.from(dag.modules.values())
      .filter((m) => m.isTarget)
      .map((m) => m.relativePath),
  );

  for (let i = 0; i < perFileFiltered.length; i += 1) {
    const a = perFileFiltered[i]!;
    const aSet = new Set(a.keys);
    const aIsTarget = targetRelFiles.has(a.file);
    for (let j = i + 1; j < perFileFiltered.length; j += 1) {
      const b = perFileFiltered[j]!;
      if (a.file === b.file || (!aIsTarget && !targetRelFiles.has(b.file))) {
        continue;
      }
      const inter = b.keys.filter((k) => aSet.has(k));
      if (inter.length < 2) {
        continue;
      }
      const sig = inter.join('|');
      if (!candidateClusters.has(sig)) {
        candidateClusters.set(sig, { keys: inter, files: new Set(), types: new Set() });
      }
    }
  }

  // Count how many distinct files contain each candidate cluster
  for (const cluster of candidateClusters.values()) {
    for (const s of perFileFiltered) {
      const sSet = new Set(s.keys);
      if (cluster.keys.every((k) => sSet.has(k))) {
        cluster.files.add(s.file);
        if (s.typeName !== '(inline)') {
          cluster.types.add(s.typeName);
        }
      }
    }
  }

  // Filter clusters with >= minOcc files and non-trivial domain field names, then prune strict subsets
  const valid = Array.from(candidateClusters.values()).filter((c) => {
    if (c.files.size < minOcc) {
      return false;
    }
    const fieldNames = c.keys.map((k) => k.split(':')[0]!);
    const nonGenericCount = fieldNames.filter((n) => !GENERIC_FIELD_NAMES.has(n)).length;
    return nonGenericCount >= 2 || (c.keys.length >= 3 && nonGenericCount >= 1);
  });

  // Sort by larger field count first, then more files
  valid.sort((a, b) => b.keys.length - a.keys.length || b.files.size - a.files.size);

  const maximal: typeof valid = [];
  for (const cand of valid) {
    const candKeySet = new Set(cand.keys);
    const isSubsumed = maximal.some((kept) => {
      const sameOrMoreFiles = Array.from(cand.files).every((f) => kept.files.has(f));
      const subsetKeys = Array.from(candKeySet).every((k) => kept.keys.includes(k));
      return sameOrMoreFiles && subsetKeys;
    });
    if (!isSubsumed) {
      maximal.push(cand);
    }
  }

  const hints: CrossFileHint[] = [];
  for (let idx = 0; idx < maximal.length; idx += 1) {
    const c = maximal[idx]!;
    const files = Array.from(c.files).sort();
    if (!involvesAnyTarget(files, dag)) {
      continue;
    }
    const fieldsReadable = c.keys.map((k) => {
      const sep = k.indexOf(':');
      return `readonly ${k.slice(0, sep)}: ${k.slice(sep + 1)}`;
    });
    const fieldNames = c.keys.map((k) => k.slice(0, k.indexOf(':')));
    const suggestedName = toPascalCase(fieldNames.slice(0, 2).join('_')) || 'SharedValueObject';

    hints.push({
      hintId: `missing-domain-model-fields-${idx + 1}`,
      category: 'missing-domain-model',
      priority: c.keys.length >= 3 || files.length >= 4 ? 'high' : 'medium',
      files,
      symbols: Array.from(c.types).sort(),
      evidence: `Field cluster { ${fieldsReadable.join('; ')} } is duplicated across ${files.length} modules (${files.join(', ')}) without a shared domain type.`,
      suggestion: `Extract a canonical Value Object / Domain Model type (e.g. "${suggestedName}") into a shared domain types module and compose it instead of repeating these fields.`,
      suggestedSignature: O.some(`export type ${suggestedName} = { ${fieldsReadable.join('; ')} };`),
      researchQuestions: [
        `Do { ${fieldNames.join(', ')} } represent a cohesive domain concept or invariant that should be validated once at construction?`,
      ],
    });
  }

  return hints;
};

const detectReinventedAdts = (
  dag: BuiltProjectDag,
  checker: ts.TypeChecker,
  minOcc: number,
): ReadonlyArray<CrossFileHint> => {
  const tagSetToOccurrences = new Map<
    string,
    { tags: ReadonlyArray<string>; files: Set<string>; symbols: Set<string> }
  >();

  for (const mod of dag.modules.values()) {
    if (mod.isBarrel) {
      continue;
    }
    for (const td of mod.ir.typeDeclarations) {
      if (!td.isDiscriminatedUnion) {
        continue;
      }
      const type = checker.getTypeAtLocation(td.node);
      if (!type.isUnion()) {
        continue;
      }
      const tags: string[] = [];
      for (const member of type.types) {
        const tagProp =
          member.getProperty('_tag') ?? member.getProperty('kind') ?? member.getProperty('type');
        if (tagProp !== undefined) {
          const propType = checker.getTypeOfSymbolAtLocation(tagProp, td.node);
          if (propType.isStringLiteral()) {
            tags.push(propType.value);
          }
        }
      }
      const uniqueTags = Array.from(new Set(tags)).sort();
      if (uniqueTags.length < 2) {
        continue;
      }
      const key = uniqueTags.join('|');
      let entry = tagSetToOccurrences.get(key);
      if (entry === undefined) {
        entry = { tags: uniqueTags, files: new Set(), symbols: new Set() };
        tagSetToOccurrences.set(key, entry);
      }
      entry.files.add(mod.relativePath);
      entry.symbols.add(td.name);
    }
  }

  const hints: CrossFileHint[] = [];
  let idx = 0;
  for (const entry of tagSetToOccurrences.values()) {
    if (entry.files.size < minOcc) {
      continue;
    }
    const files = Array.from(entry.files).sort();
    if (!involvesAnyTarget(files, dag)) {
      continue;
    }
    idx += 1;
    const symbols = Array.from(entry.symbols).sort();
    hints.push({
      hintId: `missing-domain-model-adt-${idx}`,
      category: 'missing-domain-model',
      priority: 'high',
      files,
      symbols,
      evidence: `Discriminated union with identical tag set (${entry.tags.map((t) => `'${t}'`).join(' | ')}) is redefined independently in ${files.length} modules: ${symbols.join(', ')}.`,
      suggestion:
        'Consolidate these repeated discriminated unions into a single canonical shared ADT (or parametric ADT like RemoteData<E, A> / AsyncState<E, A>) so exhaustive matchers and constructors are reused.',
      suggestedSignature: O.some(
        `export type SharedState<A, E = string> = ${entry.tags.map((t) => `{ readonly _tag: '${t}' }`).join(' | ')};`,
      ),
      researchQuestions: [
        `Are ${symbols.join(', ')} modeling the same lifecycle state machine across different entities?`,
      ],
    });
  }

  return hints;
};

const detectRepeatedDomainPrimitives = (
  dag: BuiltProjectDag,
  minOcc: number,
): ReadonlyArray<CrossFileHint> => {
  const fieldToOccurrences = new Map<
    string,
    { name: string; prim: 'string' | 'number'; files: Set<string>; types: Set<string> }
  >();

  for (const mod of dag.modules.values()) {
    if (mod.isBarrel) {
      continue;
    }
    for (const td of mod.ir.typeDeclarations) {
      if (td.isNewtype) {
        continue;
      }
      for (const field of td.fields) {
        if (!field.isRawString && !field.isRawNumber) {
          continue;
        }
        if (!DOMAIN_PRIMITIVE_FIELD_RE.test(field.name)) {
          continue;
        }
        const prim: 'string' | 'number' = field.isRawString ? 'string' : 'number';
        const key = `${field.name}:${prim}`;
        let entry = fieldToOccurrences.get(key);
        if (entry === undefined) {
          entry = { name: field.name, prim, files: new Set(), types: new Set() };
          fieldToOccurrences.set(key, entry);
        }
        entry.files.add(mod.relativePath);
        entry.types.add(td.name);
      }
    }
  }

  const hints: CrossFileHint[] = [];
  for (const entry of fieldToOccurrences.values()) {
    if (entry.files.size < minOcc) {
      continue;
    }
    const files = Array.from(entry.files).sort();
    if (!involvesAnyTarget(files, dag)) {
      continue;
    }
    const brandName = toPascalCase(entry.name);
    hints.push({
      hintId: `missing-domain-model-newtype-${entry.name}`,
      category: 'missing-domain-model',
      priority: 'medium',
      files,
      symbols: Array.from(entry.types).sort(),
      evidence: `Raw primitive field "${entry.name}: ${entry.prim}" appears unbranded across ${files.length} modules (${files.join(', ')}).`,
      suggestion: `Extract a shared newtype-ts brand "${brandName}" in a domain primitives module so "${entry.name}" values cannot be confused with arbitrary ${entry.prim}s across modules.`,
      suggestedSignature: O.some(
        `export type ${brandName} = Newtype<{ readonly ${brandName}: unique symbol }, ${entry.prim}>;`,
      ),
      researchQuestions: [
        `What validation invariant (Smart Constructor / Prism) should guard "${brandName}" at system boundaries?`,
      ],
    });
  }

  return hints;
};

// ============================================================================
// Family 2: Repeated Flow / Pipeline Motifs
// ============================================================================

const classifyFlowStepToken = (
  expr: ts.Expression,
  mod: ResolvedModuleData,
  checker: ts.TypeChecker,
  inspector: TypeInspector,
): string => {
  const unwrapped = inspector.unwrapSatisfiesAndParens(expr);

  // Direct combinator call like E.map(...), TE.chainEitherK(...), RA.filterMap(...)
  if (ts.isCallExpression(unwrapped)) {
    const callee = unwrapped.expression;
    if (ts.isPropertyAccessExpression(callee)) {
      const method = callee.name.text;
      if (FP_NAMESPACE_METHODS.has(method)) {
        const objName = ts.isIdentifier(callee.expression) ? callee.expression.text : 'FP';
        return `${objName}.${method}`;
      }
    }
    const retEffects = inspector.detectEffects(checker.getTypeAtLocation(unwrapped));
    return `call:${retEffects[0] ?? 'Pure'}`;
  }

  // Property access reference like E.right, O.fromNullable, isoUSD.unwrap
  if (ts.isPropertyAccessExpression(unwrapped)) {
    const method = unwrapped.name.text;
    if (FP_NAMESPACE_METHODS.has(method) || method === 'right' || method === 'left' || method === 'some') {
      const objName = ts.isIdentifier(unwrapped.expression) ? unwrapped.expression.text : 'FP';
      return `${objName}.${method}`;
    }
    if (method === 'unwrap' || method === 'wrap' || method === 'get' || method === 'modify') {
      return `Optic.${method}`;
    }
  }

  if (ts.isIdentifier(unwrapped)) {
    const binding = mod.ir.bindings.find((b) => b.name === unwrapped.text);
    if (binding !== undefined) {
      if (binding.kind === 'adt-matcher') {
        return 'ADT.match';
      }
      if (binding.kind === 'optic') {
        return 'Optic.op';
      }
      return `step:${binding.effects[0] ?? 'Pure'}`;
    }
    const effects = inspector.detectEffects(checker.getTypeAtLocation(unwrapped));
    return `step:${effects[0] ?? 'Pure'}`;
  }

  const effects = inspector.detectEffects(checker.getTypeAtLocation(unwrapped));
  return `step:${effects[0] ?? 'Pure'}`;
};

const isConcreteCombinatorToken = (token: string): boolean =>
  !token.startsWith('step:Pure') && !token.startsWith('call:Pure');

const detectPipelineMotifs = (
  dag: BuiltProjectDag,
  checker: ts.TypeChecker,
  inspector: TypeInspector,
  minOcc: number,
): ReadonlyArray<CrossFileHint> => {
  type FlowRecord = {
    readonly file: string;
    readonly bindingName: string;
    readonly tokens: ReadonlyArray<string>;
  };

  const flows: FlowRecord[] = [];
  for (const mod of dag.modules.values()) {
    if (mod.isBarrel) {
      continue;
    }
    for (const binding of mod.ir.bindings) {
      if (O.isNone(binding.initializer)) {
        continue;
      }
      const unwrapped = inspector.unwrapSatisfiesAndParens(binding.initializer.value);
      if (!ts.isCallExpression(unwrapped) || !inspector.isFlowCall(unwrapped)) {
        continue;
      }
      if (unwrapped.arguments.length < 3) {
        continue;
      }
      const tokens = unwrapped.arguments.map((arg) =>
        classifyFlowStepToken(arg, mod, checker, inspector),
      );
      flows.push({ file: mod.relativePath, bindingName: binding.name, tokens });
    }
  }

  // Extract contiguous n-grams of length >= 3 with at least 2 concrete FP/effect tokens
  const motifMap = new Map<
    string,
    { tokens: ReadonlyArray<string>; files: Set<string>; symbols: Set<string> }
  >();

  for (const f of flows) {
    const maxLen = Math.min(f.tokens.length, 6);
    for (let len = 3; len <= maxLen; len += 1) {
      for (let start = 0; start <= f.tokens.length - len; start += 1) {
        const slice = f.tokens.slice(start, start + len);
        const concreteCount = slice.filter(isConcreteCombinatorToken).length;
        if (concreteCount < 2) {
          continue;
        }
        const key = slice.join(' -> ');
        let entry = motifMap.get(key);
        if (entry === undefined) {
          entry = { tokens: slice, files: new Set(), symbols: new Set() };
          motifMap.set(key, entry);
        }
        entry.files.add(f.file);
        entry.symbols.add(f.bindingName);
      }
    }
  }

  const valid = Array.from(motifMap.values())
    .filter((m) => m.files.size >= minOcc)
    .sort((a, b) => b.tokens.length - a.tokens.length || b.files.size - a.files.size);

  // Prune sub-motifs covered by longer motifs on the same or larger file set
  const maximal: typeof valid = [];
  for (const cand of valid) {
    const candKey = cand.tokens.join(' -> ');
    const subsumed = maximal.some((kept) => {
      const keptKey = kept.tokens.join(' -> ');
      const sameFiles = Array.from(cand.files).every((f) => kept.files.has(f));
      return sameFiles && keptKey.includes(candKey);
    });
    if (!subsumed) {
      maximal.push(cand);
    }
  }

  const hints: CrossFileHint[] = [];
  for (let i = 0; i < maximal.length; i += 1) {
    const m = maximal[i]!;
    const files = Array.from(m.files).sort();
    if (!involvesAnyTarget(files, dag)) {
      continue;
    }
    const patternStr = m.tokens.join(' -> ');
    hints.push({
      hintId: `pipeline-motif-${i + 1}`,
      category: 'pipeline-motif',
      priority: m.tokens.length >= 4 || files.length >= 4 ? 'high' : 'medium',
      files,
      symbols: Array.from(m.symbols).sort(),
      evidence: `Recurring ${m.tokens.length}-step pipeline motif [${patternStr}] repeats across ${files.length} modules (${files.join(', ')}).`,
      suggestion:
        'Extract a reusable generic higher-order combinator / Kleisli pipeline factory that encapsulates this repeated step sequence, passing domain-specific predicates/mappers as arguments.',
      suggestedSignature: O.some(
        'export type RunDomainPipeline = <A, B, E>(steps: PipelineSteps<A, B, E>) => (input: A) => Effect<E, B>;',
      ),
      researchQuestions: [
        `Do these ${files.length} pipelines share the same error-handling or validation lifecycle that can be captured by a single reusable combinator?`,
      ],
    });
  }

  return hints;
};

// ============================================================================
// Family 3: Generic Data Types & FP Typeclasses
// ============================================================================

const parameterizeTypeText = (
  raw: string,
  domainTypes: ReadonlySet<string>,
  mapping: Map<string, string>,
): string => {
  const normalized = normalizeTypeText(raw);
  return normalized.replace(/\b[A-Z][a-zA-Z0-9_]*\b/g, (ident) => {
    if (PRIMITIVE_AND_STD_TYPES.has(ident)) {
      return ident;
    }
    if (!domainTypes.has(ident)) {
      return ident;
    }
    let param = mapping.get(ident);
    if (param === undefined) {
      param = `T${mapping.size}`;
      mapping.set(ident, param);
    }
    return param;
  });
};

const detectGenericDataTypes = (
  dag: BuiltProjectDag,
  minOcc: number,
): ReadonlyArray<CrossFileHint> => {
  // Collect all user-defined non-primitive domain type names in the project
  const allDomainTypes = new Set<string>();
  for (const mod of dag.modules.values()) {
    for (const t of mod.referencedDomainTypes) {
      allDomainTypes.add(t);
    }
    for (const td of mod.ir.typeDeclarations) {
      allDomainTypes.add(td.name);
    }
  }

  type SkeletonEntry = {
    readonly skeleton: string;
    readonly files: Set<string>;
    readonly typeNames: Set<string>;
    readonly concreteInstantiations: Set<string>;
  };

  const skeletons = new Map<string, SkeletonEntry>();

  for (const mod of dag.modules.values()) {
    if (mod.isBarrel) {
      continue;
    }
    for (const td of mod.ir.typeDeclarations) {
      if (td.isNewtype || td.isDiscriminatedUnion || td.fields.length < 2) {
        continue;
      }
      // Skip already-generic type declarations
      if (td.node.typeParameters !== undefined && td.node.typeParameters.length > 0) {
        continue;
      }

      const mapping = new Map<string, string>();
      const sortedFields = [...td.fields].sort((a, b) => a.name.localeCompare(b.name));
      const paramFields = sortedFields.map(
        (f) => `readonly ${f.name}: ${parameterizeTypeText(f.typeText, allDomainTypes, mapping)}`,
      );

      if (mapping.size === 0) {
        continue;
      }

      const skeleton = `{ ${paramFields.join('; ')} }`;
      const concreteKey = Array.from(mapping.keys()).join(',');
      let entry = skeletons.get(skeleton);
      if (entry === undefined) {
        entry = {
          skeleton,
          files: new Set(),
          typeNames: new Set(),
          concreteInstantiations: new Set(),
        };
        skeletons.set(skeleton, entry);
      }
      entry.files.add(mod.relativePath);
      entry.typeNames.add(td.name);
      entry.concreteInstantiations.add(concreteKey);
    }
  }

  const hints: CrossFileHint[] = [];
  let idx = 0;
  for (const entry of skeletons.values()) {
    // Must appear across >= minOcc files AND instantiate over >= minOcc distinct concrete domain types
    if (entry.files.size < minOcc || entry.concreteInstantiations.size < minOcc) {
      continue;
    }
    const files = Array.from(entry.files).sort();
    if (!involvesAnyTarget(files, dag)) {
      continue;
    }
    idx += 1;
    const typeList = Array.from(entry.typeNames).sort();
    const concreteList = Array.from(entry.concreteInstantiations).sort();
    const typeParams = entry.skeleton.includes('T1') ? '<T0, T1>' : '<T0>';

    hints.push({
      hintId: `generic-datatype-${idx}`,
      category: 'generic-abstraction',
      priority: 'high',
      files,
      symbols: typeList,
      evidence: `${entry.typeNames.size} monomorphic types (${typeList.join(', ')}) across ${files.length} modules share the exact parameterized structure ${entry.skeleton} instantiated over different concrete types (${concreteList.join(', ')}).`,
      suggestion: `Replace these monomorphic wrappers with a single parametric generic data type (e.g. GenericContainer${typeParams}) and reuse polymorphic operations over it.`,
      suggestedSignature: O.some(`export type GenericContainer${typeParams} = ${entry.skeleton};`),
      researchQuestions: [
        `Can ${typeList.join(', ')} be unified into one parametric type (e.g., Paginated<T>, Envelope<T>, ResultPage<T>) with shared Functor/map helpers?`,
      ],
    });
  }

  return hints;
};

type TypeclassPatternKind = 'Semigroup/Monoid' | 'Eq' | 'Ord';

const getStructuralShapeKey = (
  checker: ts.TypeChecker,
  type: ts.Type,
  location: ts.Node,
): string => {
  const props = type.getProperties();
  if (props.length > 0 && type.getCallSignatures().length === 0) {
    return props
      .map((p) => {
        const pt = normalizeTypeText(
          checker.typeToString(checker.getTypeOfSymbolAtLocation(p, location)),
        );
        return `${p.getName()}:${pt}`;
      })
      .sort()
      .join(';');
  }
  return normalizeTypeText(checker.typeToString(type));
};

const areTypesStructurallyEquivalent = (
  checker: ts.TypeChecker,
  a: ts.Type,
  b: ts.Type,
  location: ts.Node,
): boolean => {
  if (a === b) {
    return true;
  }
  const sa = normalizeTypeText(checker.typeToString(a));
  const sb = normalizeTypeText(checker.typeToString(b));
  if (sa === sb) {
    return true;
  }
  return getStructuralShapeKey(checker, a, location) === getStructuralShapeKey(checker, b, location);
};

const detectFpTypeclassOpportunities = (
  dag: BuiltProjectDag,
  checker: ts.TypeChecker,
  minOcc: number,
): ReadonlyArray<CrossFileHint> => {
  const buckets = new Map<
    TypeclassPatternKind,
    { files: Set<string>; symbols: Set<string>; concreteTypes: Set<string> }
  >();

  const record = (kind: TypeclassPatternKind, file: string, sym: string, concreteType: string): void => {
    let bucket = buckets.get(kind);
    if (bucket === undefined) {
      bucket = { files: new Set(), symbols: new Set(), concreteTypes: new Set() };
      buckets.set(kind, bucket);
    }
    bucket.files.add(file);
    bucket.symbols.add(sym);
    bucket.concreteTypes.add(concreteType);
  };

  for (const mod of dag.modules.values()) {
    if (mod.isBarrel || mod.isTypeOnlyModule || O.isNone(mod.exportedFunction)) {
      continue;
    }
    const primary = mod.ir.bindings.find((b) => b.isExported && b.kind !== 'other');
    if (primary === undefined || primary.kind === 'typeclass-instance') {
      continue;
    }
    const type = checker.getTypeAtLocation(primary.declaration);
    const sigs = type.getCallSignatures();
    if (sigs.length !== 1) {
      continue;
    }
    const sig = sigs[0]!;
    const params = sig.getParameters();
    if (params.length !== 1) {
      continue;
    }

    const p0Type = checker.getTypeOfSymbol(params[0]!);
    const retType = sig.getReturnType();

    // Case 1: Curried binary function (a: T) => (b: T) => R
    const innerSigs = retType.getCallSignatures();
    if (innerSigs.length === 1 && innerSigs[0]!.getParameters().length === 1) {
      const p1Type = checker.getTypeOfSymbol(innerSigs[0]!.getParameters()[0]!);
      const innerRet = innerSigs[0]!.getReturnType();
      const t0Str = normalizeTypeText(checker.typeToString(p0Type));
      const retStr = normalizeTypeText(checker.typeToString(innerRet));

      if (
        !PRIMITIVE_AND_STD_TYPES.has(t0Str) &&
        areTypesStructurallyEquivalent(checker, p0Type, p1Type, primary.declaration)
      ) {
        if (areTypesStructurallyEquivalent(checker, p0Type, innerRet, primary.declaration)) {
          record('Semigroup/Monoid', mod.relativePath, primary.name, t0Str);
        } else if (retStr === 'boolean') {
          record('Eq', mod.relativePath, primary.name, t0Str);
        } else if (retStr === 'Ordering' || retStr === '-1 | 0 | 1') {
          record('Ord', mod.relativePath, primary.name, t0Str);
        }
      }
      continue;
    }

    // Case 2: Unary pair record ({ a: T, b: T }) => R
    const props = p0Type.getProperties();
    if (props.length === 2) {
      const prop0TypeObj = checker.getTypeOfSymbolAtLocation(props[0]!, primary.declaration);
      const prop1TypeObj = checker.getTypeOfSymbolAtLocation(props[1]!, primary.declaration);
      const prop0Str = normalizeTypeText(checker.typeToString(prop0TypeObj));
      const retStr = normalizeTypeText(checker.typeToString(retType));

      if (
        !PRIMITIVE_AND_STD_TYPES.has(prop0Str) &&
        areTypesStructurallyEquivalent(checker, prop0TypeObj, prop1TypeObj, primary.declaration)
      ) {
        if (areTypesStructurallyEquivalent(checker, prop0TypeObj, retType, primary.declaration)) {
          record('Semigroup/Monoid', mod.relativePath, primary.name, prop0Str);
        } else if (retStr === 'boolean') {
          record('Eq', mod.relativePath, primary.name, prop0Str);
        } else if (retStr === 'Ordering' || retStr === '-1 | 0 | 1') {
          record('Ord', mod.relativePath, primary.name, prop0Str);
        }
      }
    }
  }

  const hints: CrossFileHint[] = [];
  for (const [kind, bucket] of buckets.entries()) {
    if (bucket.files.size < minOcc || bucket.concreteTypes.size < minOcc) {
      continue;
    }
    const files = Array.from(bucket.files).sort();
    if (!involvesAnyTarget(files, dag)) {
      continue;
    }
    const symbols = Array.from(bucket.symbols).sort();
    const types = Array.from(bucket.concreteTypes).sort();

    const sigSuggestion =
      kind === 'Semigroup/Monoid'
        ? 'import * as M from \'fp-ts/Monoid\'; // M.struct({ ... }) & M.concatAll(monoid)'
        : kind === 'Eq'
          ? 'import * as Eq from \'fp-ts/Eq\'; // Eq.struct({ ... })'
          : 'import * as Ord from \'fp-ts/Ord\'; // Ord.contramap(...)(baseOrd)';

    hints.push({
      hintId: `generic-typeclass-${kind.toLowerCase().replace(/[^a-z]/g, '-')}`,
      category: 'generic-abstraction',
      priority: 'medium',
      files,
      symbols,
      evidence: `${symbols.length} modules (${symbols.join(', ')}) implement ad-hoc ${kind} operations across different domain types (${types.join(', ')}).`,
      suggestion: `Model these as standard fp-ts ${kind} typeclass instances so they compose automatically with fp-ts combinators (struct, concatAll, uniq, sort, contramap).`,
      suggestedSignature: O.some(sigSuggestion),
      researchQuestions: [
        `Are these ${kind} operations associative/lawful enough to be derived via fp-ts ${kind} combinators?`,
      ],
    });
  }

  return hints;
};

// ============================================================================
// Family 4: Cross-File Environment Threading (Reader / ReaderTaskEither)
// ============================================================================

const extractEnvSignals = (
  mod: ResolvedModuleData,
  checker: ts.TypeChecker,
): ReadonlyArray<string> => {
  // Skip modules already using Reader / ReaderTask / ReaderTaskEither
  if (
    mod.exportedEffects.some(
      (e) => e === 'Reader' || e === 'ReaderTask' || e === 'ReaderTaskEither',
    )
  ) {
    return [];
  }
  const primary = mod.ir.bindings.find((b) => b.isExported && b.kind !== 'other');
  if (primary === undefined) {
    return [];
  }
  const type = checker.getTypeAtLocation(primary.declaration);
  const sigs = type.getCallSignatures();
  if (sigs.length !== 1) {
    return [];
  }
  const sig = sigs[0]!;
  const params = sig.getParameters();
  if (params.length !== 1) {
    return [];
  }

  const p0 = params[0]!;
  const p0Type = checker.getTypeOfSymbol(p0);
  const p0SymName = p0Type.aliasSymbol?.getName() ?? p0Type.getSymbol()?.getName() ?? '';
  const signals = new Set<string>();

  // Direct env parameter (e.g., curried `(env: AppEnv) => (input: ...) => ...` or `(ctx: DbContext) => ...`)
  if (ENV_FIELD_NAMES.has(p0.getName()) || ENV_TYPE_NAME_RE.test(p0SymName)) {
    signals.add(p0SymName.length > 0 && !p0SymName.startsWith('__') ? `type:${p0SymName}` : `param:${p0.getName()}`);
  }

  // Env fields inside Input record (e.g., `{ db: DbClient; logger: Logger; orderId: OrderId }`)
  for (const prop of p0Type.getProperties()) {
    const propName = prop.getName();
    const propType = checker.getTypeOfSymbolAtLocation(prop, primary.declaration);
    const propTypeName = propType.aliasSymbol?.getName() ?? propType.getSymbol()?.getName() ?? '';
    if (ENV_FIELD_NAMES.has(propName) || ENV_TYPE_NAME_RE.test(propTypeName)) {
      if (propTypeName.length > 0 && !propTypeName.startsWith('__')) {
        signals.add(`type:${propTypeName}`);
      } else {
        signals.add(`field:${propName}`);
      }
    }
  }

  return Array.from(signals);
};

const detectEnvironmentThreading = (
  dag: BuiltProjectDag,
  checker: ts.TypeChecker,
  minOcc: number,
): ReadonlyArray<CrossFileHint> => {
  const signalToFiles = new Map<string, Set<string>>();

  for (const mod of dag.modules.values()) {
    if (mod.isBarrel || mod.isTypeOnlyModule) {
      continue;
    }
    const signals = extractEnvSignals(mod, checker);
    for (const s of signals) {
      let set = signalToFiles.get(s);
      if (set === undefined) {
        set = new Set();
        signalToFiles.set(s, set);
      }
      set.add(mod.filePath);
    }
  }

  const hints: CrossFileHint[] = [];
  for (const [signal, fileSet] of signalToFiles.entries()) {
    if (fileSet.size < minOcc) {
      continue;
    }

    // Find connected components within the call DAG (undirected over runtimeOutEdges/runtimeInEdges)
    const visited = new Set<string>();
    for (const start of Array.from(fileSet).sort()) {
      if (visited.has(start)) {
        continue;
      }
      const comp: string[] = [];
      const queue = [start];
      visited.add(start);
      while (queue.length > 0) {
        const curr = queue.shift()!;
        comp.push(curr);
        const neighbors = [
          ...(dag.runtimeOutEdges.get(curr) ?? []),
          ...(dag.runtimeInEdges.get(curr) ?? []),
        ];
        for (const next of neighbors) {
          if (fileSet.has(next) && !visited.has(next)) {
            visited.add(next);
            queue.push(next);
          }
        }
      }

      if (comp.length < minOcc) {
        continue;
      }

      const relFiles = comp.map((f) => dag.modules.get(f)!.relativePath).sort();
      if (!involvesAnyTarget(relFiles, dag)) {
        continue;
      }
      const symbols = comp
        .map((f) => dag.modules.get(f)?.exportedFunction)
        .filter((o): o is O.Some<string> => o !== undefined && O.isSome(o))
        .map((s) => s.value)
        .sort();

      const hasAsync = comp.some((f) => isEffectfulIo(dag.modules.get(f)?.exportedEffects ?? []));
      const monad = hasAsync ? 'ReaderTaskEither<Env, Err, A>' : 'Reader<Env, A>';
      const cleanSignal = signal.replace(/^(?:type|field|param):/, '');

      hints.push({
        hintId: `environment-threading-${cleanSignal.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
        category: 'environment-threading',
        priority: 'high',
        files: relFiles,
        symbols,
        evidence: `Dependency/environment "${cleanSignal}" is manually threaded across ${comp.length} connected modules in the call DAG (${relFiles.join(', ')}).`,
        suggestion: `Lift this call-chain subgraph into ${monad} so "${cleanSignal}" is injected once at the application boundary instead of threaded through every intermediate signature.`,
        suggestedSignature: O.some(
          hasAsync
            ? `export type DomainOp = (input: Input) => RTE.ReaderTaskEither<${cleanSignal}, DomainError, Output>;`
            : `export type DomainOp = (input: Input) => R.Reader<${cleanSignal}, Output>;`,
        ),
        researchQuestions: [
          `Should "${cleanSignal}" become part of a shared Reader environment composed via ReaderTaskEither.ask / local?`,
        ],
      });
    }
  }

  return hints;
};

// ============================================================================
// Family 5: Architectural DAG Motifs (Strategy, Core/Shell, Cross-File Optics)
// ============================================================================

const detectParallelStrategyMotif = (
  dag: BuiltProjectDag,
  minOcc: number,
): ReadonlyArray<CrossFileHint> => {
  const sigToMods = new Map<string, ResolvedModuleData[]>();

  for (const mod of dag.modules.values()) {
    if (mod.isBarrel || mod.isTypeOnlyModule || O.isNone(mod.exportedSignature)) {
      continue;
    }
    // Require at least one domain type so trivial `(x: string) => string` functions don't trigger Strategy
    if (mod.referencedDomainTypes.length === 0) {
      continue;
    }
    // Normalize parameter name out of signature: `(foo: Order) => USD` -> `(Order) => USD`
    const normalizedSig = normalizeTypeText(mod.exportedSignature.value).replace(
      /\(\s*[a-zA-Z_$][\w$]*\s*:\s*/g,
      '(',
    );
    const list = sigToMods.get(normalizedSig);
    if (list === undefined) {
      sigToMods.set(normalizedSig, [mod]);
    } else {
      list.push(mod);
    }
  }

  const hints: CrossFileHint[] = [];
  let idx = 0;
  for (const [sig, mods] of sigToMods.entries()) {
    if (mods.length < minOcc) {
      continue;
    }
    const files = mods.map((m) => m.relativePath).sort();
    if (!involvesAnyTarget(files, dag)) {
      continue;
    }
    idx += 1;
    const symbols = mods
      .map((m) => m.exportedFunction)
      .filter(O.isSome)
      .map((s) => s.value)
      .sort();

    hints.push({
      hintId: `architectural-motif-strategy-${idx}`,
      category: 'architectural-motif',
      priority: 'medium',
      files,
      symbols,
      evidence: `${mods.length} parallel modules (${symbols.join(', ')}) implement the identical domain contract \`${sig}\`.`,
      suggestion:
        'Recognize this emergent Strategy / Handler Registry pattern: define a shared named Strategy type alias and dispatch via a typed Record<StrategyKey, Handler> or exhaustive ts-pattern matcher.',
      suggestedSignature: O.some(`export type StrategyHandler = ${sig};`),
      researchQuestions: [
        `Are ${symbols.join(', ')} interchangeable strategies selected by a domain discriminant tag?`,
      ],
    });
  }

  return hints;
};

const detectEffectLayerLeakage = (
  dag: BuiltProjectDag,
  minOcc: number,
): ReadonlyArray<CrossFileHint> => {
  const hints: CrossFileHint[] = [];

  // 1. Direct pure-to-IO dependency edge
  const leakyEdges: { caller: ResolvedModuleData; callee: ResolvedModuleData }[] = [];
  for (const mod of dag.modules.values()) {
    if (mod.isBarrel || mod.isTypeOnlyModule || mod.exportedEffects.length === 0) {
      continue;
    }
    if (isEffectfulIo(mod.exportedEffects)) {
      continue;
    }
    for (const targetFile of dag.runtimeOutEdges.get(mod.filePath) ?? []) {
      const targetMod = dag.modules.get(targetFile);
      if (targetMod !== undefined && !targetMod.isBarrel && isEffectfulIo(targetMod.exportedEffects)) {
        leakyEdges.push({ caller: mod, callee: targetMod });
      }
    }
  }

  for (let i = 0; i < leakyEdges.length; i += 1) {
    const { caller, callee } = leakyEdges[i]!;
    if (!caller.isTarget && !callee.isTarget) {
      continue;
    }
    const callerFn = O.getOrElse(() => caller.relativePath)(caller.exportedFunction);
    const calleeFn = O.getOrElse(() => callee.relativePath)(callee.exportedFunction);
    hints.push({
      hintId: `architectural-motif-effect-leak-${i + 1}`,
      category: 'architectural-motif',
      priority: 'high',
      files: [caller.relativePath, callee.relativePath],
      symbols: [callerFn, calleeFn],
      evidence: `Pure/synchronous module "${caller.relativePath}" (${caller.exportedEffects.join('/')}) imports async/I/O module "${callee.relativePath}" (${callee.exportedEffects.join('/')}).`,
      suggestion:
        'Apply Functional Core, Imperative Shell: keep pure domain modules free of async/I/O dependencies and pass fetched data into pure functions from the outer TaskEither shell.',
      suggestedSignature: O.none,
      researchQuestions: [
        `Can "${calleeFn}" be invoked in an outer TaskEither shell so "${callerFn}" stays purely synchronous?`,
      ],
    });
  }

  // 2. Deep I/O propagation across >= minOcc layered async modules (leaf layer 0 is IO and propagates upward)
  const ioLeafs = Array.from(dag.modules.values()).filter((m) => {
    const node = dag.nodeByFile.get(m.filePath);
    return (
      node !== undefined &&
      !m.isBarrel &&
      !m.isTypeOnlyModule &&
      node.layer === 0 &&
      isEffectfulIo(m.exportedEffects) &&
      (dag.runtimeInEdges.get(m.filePath)?.size ?? 0) > 0
    );
  });

  if (ioLeafs.length > 0) {
    const ioPropagated = new Set<string>();
    const queue = ioLeafs.map((m) => m.filePath);
    for (const f of queue) {
      ioPropagated.add(f);
    }
    while (queue.length > 0) {
      const curr = queue.shift()!;
      for (const caller of dag.runtimeInEdges.get(curr) ?? []) {
        const callerMod = dag.modules.get(caller);
        if (
          callerMod !== undefined &&
          !callerMod.isBarrel &&
          isEffectfulIo(callerMod.exportedEffects) &&
          !ioPropagated.has(caller)
        ) {
          ioPropagated.add(caller);
          queue.push(caller);
        }
      }
    }

    const propagatedLayers = new Set(
      Array.from(ioPropagated).map((f) => dag.nodeByFile.get(f)?.layer ?? 0),
    );

    if (ioPropagated.size >= minOcc && propagatedLayers.size >= 3) {
      const files = Array.from(ioPropagated)
        .map((f) => dag.modules.get(f)!.relativePath)
        .sort();
      if (involvesAnyTarget(files, dag)) {
        const symbols = Array.from(ioPropagated)
          .map((f) => dag.modules.get(f)?.exportedFunction)
          .filter((o): o is O.Some<string> => o !== undefined && O.isSome(o))
          .map((s) => s.value)
          .sort();

        hints.push({
          hintId: 'architectural-motif-deep-io-chain',
          category: 'architectural-motif',
          priority: 'medium',
          files,
          symbols,
          evidence: `Async/I/O effects propagate across ${propagatedLayers.size} DAG layers and ${files.length} modules (${files.join(', ')}) starting from leaf I/O modules.`,
          suggestion:
            'Apply Functional Core, Imperative Shell (Ports & Adapters): fetch inputs at the boundary shell, compose intermediate domain logic as pure Either functions, and persist results at the edge.',
          suggestedSignature: O.none,
          researchQuestions: [
            'Which intermediate modules in this TaskEither chain are pure business logic that only became async because they call a leaf I/O module directly?',
          ],
        });
      }
    }
  }

  return hints;
};

const detectCrossFileSharedOptics = (
  dag: BuiltProjectDag,
  checker: ts.TypeChecker,
  minOcc: number,
): ReadonlyArray<CrossFileHint> => {
  const pathToOccurrences = new Map<
    string,
    { rootType: string; pathParts: ReadonlyArray<string>; files: Set<string> }
  >();

  for (const mod of dag.modules.values()) {
    if (mod.isBarrel) {
      continue;
    }

    const visit = (node: ts.Node): void => {
      // Only inspect outermost PropertyAccessExpression of a chain
      if (
        ts.isPropertyAccessExpression(node) &&
        !ts.isPropertyAccessExpression(node.parent)
      ) {
        const parts: string[] = [];
        let curr: ts.Expression = node;
        while (ts.isPropertyAccessExpression(curr)) {
          parts.unshift(curr.name.text);
          curr = curr.expression;
        }
        // Ignore method calls at the tail (e.g. a.b.map(...))
        if (ts.isCallExpression(node.parent) && node.parent.expression === node) {
          parts.pop();
        }
        if (parts.length >= 2 && ts.isIdentifier(curr)) {
          const rootType = checker.getTypeAtLocation(curr);
          const sym = rootType.aliasSymbol ?? rootType.getSymbol();
          const rootTypeName = sym?.getName() ?? '';
          if (
            rootTypeName.length > 0 &&
            !rootTypeName.startsWith('__') &&
            !PRIMITIVE_AND_STD_TYPES.has(rootTypeName) &&
            !mod.ir.imports.some(
              (imp) =>
                (O.isSome(imp.namespaceImport) && imp.namespaceImport.value === curr.text) ||
                (O.isSome(imp.defaultImport) && imp.defaultImport.value === curr.text),
            )
          ) {
            const key = `${rootTypeName}.${parts.join('.')}`;
            let entry = pathToOccurrences.get(key);
            if (entry === undefined) {
              entry = { rootType: rootTypeName, pathParts: parts, files: new Set() };
              pathToOccurrences.set(key, entry);
            }
            entry.files.add(mod.relativePath);
          }
        }
      }
      ts.forEachChild(node, visit);
    };

    visit(mod.sourceFile);
  }

  const hints: CrossFileHint[] = [];
  let idx = 0;
  for (const entry of pathToOccurrences.values()) {
    if (entry.files.size < minOcc) {
      continue;
    }
    const files = Array.from(entry.files).sort();
    if (!involvesAnyTarget(files, dag)) {
      continue;
    }
    idx += 1;
    const pathTuple = entry.pathParts.map((p) => `'${p}'`).join(', ');
    hints.push({
      hintId: `architectural-motif-shared-optic-${idx}`,
      category: 'architectural-motif',
      priority: 'medium',
      files,
      symbols: [entry.rootType],
      evidence: `Nested property path "${entry.rootType}.${entry.pathParts.join('.')}" is traversed independently across ${files.length} modules (${files.join(', ')}).`,
      suggestion: `Extract a shared monocle-ts Lens/Optional alongside "${entry.rootType}" so structural navigation and updates stay decoupled from internal nesting.`,
      suggestedSignature: O.some(`Lens.fromPath<${entry.rootType}>()([${pathTuple}])`),
      researchQuestions: [
        `Should "${entry.rootType}" expose a shared Lens/Optional module for [${pathTuple}]?`,
      ],
    });
  }

  return hints;
};

export const runPatternDiscoveryDetectors = (
  dag: BuiltProjectDag,
  checker: ts.TypeChecker,
  inspector: TypeInspector,
  options: PatternDiscoveryOptions,
): ReadonlyArray<CrossFileHint> => {
  const minOcc = options.minPatternOccurrences;
  return [
    ...detectRepeatedFieldClusters(dag, checker, minOcc),
    ...detectReinventedAdts(dag, checker, minOcc),
    ...detectRepeatedDomainPrimitives(dag, minOcc),
    ...detectPipelineMotifs(dag, checker, inspector, minOcc),
    ...detectGenericDataTypes(dag, minOcc),
    ...detectFpTypeclassOpportunities(dag, checker, minOcc),
    ...detectEnvironmentThreading(dag, checker, minOcc),
    ...detectParallelStrategyMotif(dag, minOcc),
    ...detectEffectLayerLeakage(dag, minOcc),
    ...detectCrossFileSharedOptics(dag, checker, minOcc),
  ];
};
