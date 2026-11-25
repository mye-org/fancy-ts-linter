import { constant, flow } from 'fp-ts/lib/function.js';
import * as Eq from 'fp-ts/lib/Eq.js';
import * as O from 'fp-ts/lib/Option.js';
import * as RA from 'fp-ts/lib/ReadonlyArray.js';
import * as S from 'fp-ts/lib/string.js';
import * as ts from 'typescript';
import { match } from 'ts-pattern';
import type {
  BindingInfo,
  FieldInfo,
  ImportInfo,
  ModuleIR,
  NodeKind,
  TypeDeclInfo,
  TypeFlowEdge,
  TypeInspector,
} from '../model/report.js';

export type ExtractModuleIRInput = {
  readonly sourceFile: ts.SourceFile;
  readonly checker: ts.TypeChecker;
  readonly inspector: TypeInspector;
};

export type ExtractModuleIR = (input: ExtractModuleIRInput) => ModuleIR;

const collectNodes = (sf: ts.SourceFile) => (node: ts.Node): ReadonlyArray<ts.Node> => [
  node,
  ...RA.chain(collectNodes(sf))(node.getChildren(sf)),
];

const isExportKeyword = (m: ts.ModifierLike) => m.kind === ts.SyntaxKind.ExportKeyword;

const hasExportModifier = (node: ts.HasModifiers) =>
  O.exists(RA.some(isExportKeyword))(
    O.chain(flow(ts.getModifiers, O.fromNullable))(O.fromPredicate(ts.canHaveModifiers)(node)),
  );

const readStringLiteralText = (expr: ts.StringLiteral) => expr.text;
const getExprText = (expr: ts.Expression) => expr.getText();

const getStringLiteralText = (expr: ts.Expression) =>
  match(expr).when(ts.isStringLiteral, readStringLiteralText).otherwise(getExprText);

const readNamedBindingText = (spec: ts.ImportSpecifier) => spec.name.text;
const readNamedImports = (nb: ts.NamedImports) => RA.map(readNamedBindingText)(nb.elements);

const extractNamedBindings = (nb: ts.NamedImportBindings) =>
  match(nb)
    .when(ts.isNamedImports, readNamedImports)
    .otherwise(constant<ReadonlyArray<string>>([]));

const extractNamedImports = (clause: ts.ImportClause) =>
  O.match(
    constant<ReadonlyArray<string>>([]),
    extractNamedBindings,
  )(O.fromNullable(clause.namedBindings));

const readNamespaceImportName = (nb: ts.NamespaceImport) => nb.name.text;

const extractNamespaceFromBindings = flow(
  O.fromPredicate(ts.isNamespaceImport),
  O.map(readNamespaceImportName),
);

const extractNamespaceImport = (clause: ts.ImportClause) =>
  O.chain(extractNamespaceFromBindings)(O.fromNullable(clause.namedBindings));

const readIdentifierText = (id: ts.Identifier) => id.text;
const getImportClauseName = (c: ts.ImportClause) =>
  O.map(readIdentifierText)(O.fromNullable(c.name));
const isClauseTypeOnly = (c: ts.ImportClause) => c.isTypeOnly;

const toImportInfo = (stmt: ts.ImportDeclaration) => ({
  moduleSpecifier: getStringLiteralText(stmt.moduleSpecifier),
  defaultImport: O.chain(getImportClauseName)(O.fromNullable(stmt.importClause)),
  namespaceImport: O.chain(extractNamespaceImport)(O.fromNullable(stmt.importClause)),
  namedImports: O.match(
    constant<ReadonlyArray<string>>([]),
    extractNamedImports,
  )(O.fromNullable(stmt.importClause)),
  isTypeOnly: O.exists(isClauseTypeOnly)(O.fromNullable(stmt.importClause)),
});

const extractImports = (sf: ts.SourceFile) =>
  flow(
    RA.filter(ts.isImportDeclaration),
    RA.map(toImportInfo),
  )(sf.statements);

const isBooleanType = (t: ts.Type) => (t.flags & ts.TypeFlags.BooleanLike) !== 0;

const isRawStringType = (t: ts.Type) => (t.flags & ts.TypeFlags.StringLike) !== 0;

const isRawNumberType = (t: ts.Type) => (t.flags & ts.TypeFlags.NumberLike) !== 0;

const buildFieldInfo = ({
  inspector,
  prop,
  propType,
  nonNullType,
  isNewtype,
}: {
  readonly inspector: TypeInspector;
  readonly prop: ts.Symbol;
  readonly propType: ts.Type;
  readonly nonNullType: ts.Type;
  readonly isNewtype: boolean;
}) => ({
  name: prop.getName(),
  typeText: inspector.formatType(propType),
  isBoolean: isBooleanType(nonNullType),
  isOptional: (prop.flags & ts.SymbolFlags.Optional) !== 0,
  isNullable: inspector.hasNullablePart(propType),
  isRawString: !isNewtype && isRawStringType(nonNullType),
  isRawNumber: !isNewtype && isRawNumberType(nonNullType),
  isNewtype,
});

const withNonNullType =
  ({
    inspector,
    prop,
    propType,
  }: {
    readonly inspector: TypeInspector;
    readonly prop: ts.Symbol;
    readonly propType: ts.Type;
  }) =>
  (nonNullType: ts.Type) =>
    buildFieldInfo({
      inspector,
      prop,
      propType,
      nonNullType,
      isNewtype: inspector.isNewtypeBrand(nonNullType),
    });

const toFieldWithPropType =
  ({
    checker,
    inspector,
    prop,
  }: {
    readonly checker: ts.TypeChecker;
    readonly inspector: TypeInspector;
    readonly prop: ts.Symbol;
  }) =>
  (propType: ts.Type) =>
    withNonNullType({ inspector, prop, propType })(checker.getNonNullableType(propType));

const propertySymbolToField =
  ({
    checker,
    inspector,
    declNode,
  }: {
    readonly checker: ts.TypeChecker;
    readonly inspector: TypeInspector;
    readonly declNode: ts.Node;
  }) =>
  (prop: ts.Symbol) =>
    toFieldWithPropType({ checker, inspector, prop })(
      checker.getTypeOfSymbolAtLocation(prop, declNode),
    );

const isDiscriminantProp = (p: ts.Symbol) =>
  p.getName() === '_tag' || p.getName() === 'kind' || p.getName() === 'type';

const hasDiscriminantProp = (member: ts.Type) =>
  RA.some(isDiscriminantProp)(member.getProperties());

const isDiscriminatedUnionType = (type: ts.Type) =>
  type.isUnion() && RA.every(hasDiscriminantProp)(type.types);

const isTypeOrInterfaceDecl = (
  stmt: ts.Statement,
): stmt is ts.TypeAliasDeclaration | ts.InterfaceDeclaration =>
  ts.isTypeAliasDeclaration(stmt) || ts.isInterfaceDeclaration(stmt);

const buildTypeDeclInfo =
  ({
    sourceFile,
    checker,
    inspector,
    node,
  }: ExtractModuleIRInput & { readonly node: ts.TypeAliasDeclaration | ts.InterfaceDeclaration }) =>
  (type: ts.Type): TypeDeclInfo => ({
    name: node.name.text,
    isExported: hasExportModifier(node),
    isNewtype: inspector.isNewtypeBrand(type),
    isDiscriminatedUnion: isDiscriminatedUnionType(type),
    fields: RA.map(propertySymbolToField({ checker, inspector, declNode: node }))(
      type.getProperties(),
    ),
    location: inspector.getLocation(sourceFile)(node),
    node,
  });

const toTypeDeclInfo =
  (input: ExtractModuleIRInput) =>
  (node: ts.TypeAliasDeclaration | ts.InterfaceDeclaration) =>
    buildTypeDeclInfo({ ...input, node })(input.checker.getTypeAtLocation(node));

const extractTypeDeclarations = (input: ExtractModuleIRInput) =>
  flow(
    RA.filter(isTypeOrInterfaceDecl),
    RA.map(toTypeDeclInfo(input)),
  )(input.sourceFile.statements);

const containsTsPatternMatch = ({
  sf,
  inspector,
  expr,
}: {
  readonly sf: ts.SourceFile;
  readonly inspector: TypeInspector;
  readonly expr: ts.Expression;
}) => RA.some(inspector.isTsPatternMatch)(collectNodes(sf)(expr));

const hasAtMostOneParam = (s: ts.Signature) => s.getParameters().length <= 1;

const isPartialAppCall =
  ({ inspector, type }: { readonly inspector: TypeInspector; readonly type: ts.Type }) =>
  (e: ts.CallExpression) =>
    (inspector.isUnaryFunctionType(type) ||
      (type.getCallSignatures().length > 0 &&
        RA.every(hasAtMostOneParam)(type.getCallSignatures()))) &&
    !inspector.isFlowCall(e);

const isExportedFlowCall =
  ({ inspector, isExported }: { readonly inspector: TypeInspector; readonly isExported: boolean }) =>
  (e: ts.Expression) =>
    inspector.isFlowCall(e) && isExported;

const hasTsPatternMatch =
  ({ sf, inspector }: { readonly sf: ts.SourceFile; readonly inspector: TypeInspector }) =>
  (e: ts.Expression) =>
    containsTsPatternMatch({ sf, inspector, expr: e });

const matchUnwrappedKind =
  ({
    sf,
    inspector,
    isExported,
    type,
  }: {
    readonly sf: ts.SourceFile;
    readonly inspector: TypeInspector;
    readonly isExported: boolean;
    readonly type: ts.Type;
  }) =>
  (unwrapped: ts.Expression) =>
    match(unwrapped)
      .when(isExportedFlowCall({ inspector, isExported }), constant<NodeKind>('exported-flow'))
      .when(inspector.isFlowCall, constant<NodeKind>('sub-flow'))
      .when(constant(inspector.isOpticType(type)), constant<NodeKind>('optic'))
      .when(
        constant(inspector.isTypeclassInstance(type)),
        constant<NodeKind>('typeclass-instance'),
      )
      .when(hasTsPatternMatch({ sf, inspector }), constant<NodeKind>('adt-matcher'))
      .when(ts.isArrowFunction, constant<NodeKind>('leaf-fn'))
      .when(
        ts.isCallExpression,
        flow(
          O.fromPredicate(isPartialAppCall({ inspector, type })),
          O.match(constant<NodeKind>('other'), constant<NodeKind>('partial-app')),
        ),
      )
      .otherwise(constant<NodeKind>('other'));

const classifyBindingKind = ({
  sf,
  inspector,
  isExported,
  type,
  initOpt,
}: {
  readonly sf: ts.SourceFile;
  readonly inspector: TypeInspector;
  readonly isExported: boolean;
  readonly type: ts.Type;
  readonly initOpt: O.Option<ts.Expression>;
}) =>
  O.match(
    constant<NodeKind>('other'),
    flow(
      inspector.unwrapSatisfiesAndParens,
      matchUnwrappedKind({ sf, inspector, isExported, type }),
    ),
  )(initOpt);

const isFlowCallExpr =
  (inspector: TypeInspector) =>
  (expr: ts.Expression): expr is ts.CallExpression =>
    ts.isCallExpression(expr) && inspector.isFlowCall(expr);

const getCallArgs = (call: ts.CallExpression) => call.arguments;
const getCallArgCount = (call: ts.CallExpression) => call.arguments.length;

const countFlowSteps = (inspector: TypeInspector) =>
  O.chain(
    flow(
      inspector.unwrapSatisfiesAndParens,
      O.fromPredicate(isFlowCallExpr(inspector)),
      O.map(getCallArgCount),
    ),
  );

const isAnnotatedArrow = (expr: ts.Expression) =>
  ts.isArrowFunction(expr) && expr.type !== undefined;

const hasExplicitReturnAnnotation = (inspector: TypeInspector) =>
  O.exists(flow(inspector.unwrapSatisfiesAndParens, isAnnotatedArrow));

const buildBindingInfo =
  ({
    sourceFile,
    inspector,
    stmt,
    isExported,
    decl,
    name,
    initOpt,
  }: {
    readonly sourceFile: ts.SourceFile;
    readonly inspector: TypeInspector;
    readonly stmt: ts.VariableStatement;
    readonly isExported: boolean;
    readonly decl: ts.VariableDeclaration;
    readonly name: ts.Identifier;
    readonly initOpt: O.Option<ts.Expression>;
  }) =>
  (type: ts.Type): ReadonlyArray<BindingInfo> => [
    {
      name: name.text,
      isExported,
      kind: classifyBindingKind({ sf: sourceFile, inspector, isExported, type, initOpt }),
      hasSatisfies: O.exists(ts.isSatisfiesExpression)(initOpt),
      hasExplicitReturnType:
        decl.type !== undefined || hasExplicitReturnAnnotation(inspector)(initOpt),
      signature: inspector.formatType(type),
      effects: inspector.detectEffects(type),
      stepCount: countFlowSteps(inspector)(initOpt),
      location: inspector.getLocation(sourceFile)(decl),
      declaration: decl,
      statement: stmt,
      initializer: initOpt,
    },
  ];

const identDeclToBinding =
  ({
    sourceFile,
    checker,
    inspector,
    stmt,
    isExported,
    decl,
  }: ExtractModuleIRInput & {
    readonly stmt: ts.VariableStatement;
    readonly isExported: boolean;
    readonly decl: ts.VariableDeclaration;
  }) =>
  (name: ts.Identifier) =>
    buildBindingInfo({
      sourceFile,
      inspector,
      stmt,
      isExported,
      decl,
      name,
      initOpt: O.fromNullable(decl.initializer),
    })(checker.getTypeAtLocation(decl));

const declToBindings =
  (
    ctx: ExtractModuleIRInput & {
      readonly stmt: ts.VariableStatement;
      readonly isExported: boolean;
    },
  ) =>
  (decl: ts.VariableDeclaration) =>
    O.match(
      constant<ReadonlyArray<BindingInfo>>([]),
      identDeclToBinding({ ...ctx, decl }),
    )(O.fromPredicate(ts.isIdentifier)(decl.name));

const statementToBindings = (input: ExtractModuleIRInput) => (stmt: ts.VariableStatement) =>
  RA.chain(declToBindings({ ...input, stmt, isExported: hasExportModifier(stmt) }))(
    stmt.declarationList.declarations,
  );

const extractBindings = (input: ExtractModuleIRInput) =>
  flow(
    RA.filter(ts.isVariableStatement),
    RA.chain(statementToBindings(input)),
  )(input.sourceFile.statements);

const isKnownBindingIdent =
  (bindingNames: ReadonlyArray<string>) =>
  (node: ts.Node): node is ts.Identifier =>
    ts.isIdentifier(node) && RA.elem(S.Eq)(node.text)(bindingNames);

const makeFlowStepEdge = (from: string) => (id: ts.Identifier): TypeFlowEdge => ({
  from,
  to: id.text,
  role: 'flow-step',
});

const makeUsesEdge = (from: string) => (id: ts.Identifier): TypeFlowEdge => ({
  from,
  to: id.text,
  role: 'uses',
});

const toFlowStepEdge = ({
  bindingName,
  bindingNames,
}: {
  readonly bindingName: string;
  readonly bindingNames: ReadonlyArray<string>;
}) =>
  flow(
    O.fromPredicate(isKnownBindingIdent(bindingNames)),
    O.map(makeFlowStepEdge(bindingName)),
  );

const isOtherKnownBindingIdent =
  ({
    bindingName,
    bindingNames,
  }: {
    readonly bindingName: string;
    readonly bindingNames: ReadonlyArray<string>;
  }) =>
  (n: ts.Node): n is ts.Identifier =>
    isKnownBindingIdent(bindingNames)(n) && n.text !== bindingName;

const toUsesEdge = ({
  bindingName,
  bindingNames,
}: {
  readonly bindingName: string;
  readonly bindingNames: ReadonlyArray<string>;
}) =>
  flow(
    O.fromPredicate(isOtherKnownBindingIdent({ bindingName, bindingNames })),
    O.map(makeUsesEdge(bindingName)),
  );

const collectFlowArgEdges = ({
  bindingName,
  bindingNames,
}: {
  readonly bindingName: string;
  readonly bindingNames: ReadonlyArray<string>;
}) => flow(getCallArgs, RA.filterMap(toFlowStepEdge({ bindingName, bindingNames })));

const extractFlowArgEdges = ({
  inspector,
  bindingName,
  bindingNames,
}: {
  readonly inspector: TypeInspector;
  readonly bindingName: string;
  readonly bindingNames: ReadonlyArray<string>;
}) =>
  flow(
    O.fromPredicate(isFlowCallExpr(inspector)),
    O.match(
      constant<ReadonlyArray<TypeFlowEdge>>([]),
      collectFlowArgEdges({ bindingName, bindingNames }),
    ),
  );

const extractEdgesFromUnwrapped =
  ({
    sf,
    inspector,
    bindingName,
    bindingNames,
  }: {
    readonly sf: ts.SourceFile;
    readonly inspector: TypeInspector;
    readonly bindingName: string;
    readonly bindingNames: ReadonlyArray<string>;
  }) =>
  (unwrapped: ts.Expression) =>
    RA.uniq<TypeFlowEdge>(Eq.struct({ from: S.Eq, to: S.Eq, role: S.Eq }))([
      ...extractFlowArgEdges({ inspector, bindingName, bindingNames })(unwrapped),
      ...RA.filterMap(toUsesEdge({ bindingName, bindingNames }))(collectNodes(sf)(unwrapped)),
    ]);

const extractEdgesForBinding =
  ({
    sf,
    inspector,
    bindingNames,
  }: {
    readonly sf: ts.SourceFile;
    readonly inspector: TypeInspector;
    readonly bindingNames: ReadonlyArray<string>;
  }) =>
  (binding: BindingInfo) =>
    O.match(
      constant<ReadonlyArray<TypeFlowEdge>>([]),
      flow(
        inspector.unwrapSatisfiesAndParens,
        extractEdgesFromUnwrapped({
          sf,
          inspector,
          bindingName: binding.name,
          bindingNames,
        }),
      ),
    )(binding.initializer);

const toTypeFlowNode = (b: BindingInfo) => ({
  name: b.name,
  kind: b.kind,
  signature: b.signature,
  effects: b.effects,
  stepCount: b.stepCount,
});

const getBindingName = (b: BindingInfo) => b.name;

const assembleModuleIR =
  ({
    sourceFile,
    imports,
    typeDeclarations,
    bindings,
  }: {
    readonly sourceFile: ts.SourceFile;
    readonly imports: ReadonlyArray<ImportInfo>;
    readonly typeDeclarations: ReadonlyArray<TypeDeclInfo>;
    readonly bindings: ReadonlyArray<BindingInfo>;
  }) =>
  (edges: ReadonlyArray<TypeFlowEdge>): ModuleIR => ({
    filePath: sourceFile.fileName,
    imports,
    typeDeclarations,
    bindings,
    edges,
    typeFlowGraph: {
      nodes: RA.map(toTypeFlowNode)(bindings),
      edges,
    },
  });

const buildModuleIRWithBindings =
  ({
    input,
    imports,
    typeDeclarations,
  }: {
    readonly input: ExtractModuleIRInput;
    readonly imports: ReadonlyArray<ImportInfo>;
    readonly typeDeclarations: ReadonlyArray<TypeDeclInfo>;
  }) =>
  (bindings: ReadonlyArray<BindingInfo>) =>
    assembleModuleIR({
      sourceFile: input.sourceFile,
      imports,
      typeDeclarations,
      bindings,
    })(
      RA.chain(
        extractEdgesForBinding({
          sf: input.sourceFile,
          inspector: input.inspector,
          bindingNames: RA.map(getBindingName)(bindings),
        }),
      )(bindings),
    );

const buildModuleIR = (input: ExtractModuleIRInput) =>
  buildModuleIRWithBindings({
    input,
    imports: extractImports(input.sourceFile),
    typeDeclarations: extractTypeDeclarations(input),
  })(extractBindings(input));

const passInput = (input: ExtractModuleIRInput) => input;

export const extractModuleIR = flow(
  passInput,
  buildModuleIR,
) satisfies ExtractModuleIR;
