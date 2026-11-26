import { constant, flow } from 'fp-ts/lib/function.js';
import * as B from 'fp-ts/lib/boolean.js';
import * as Eq from 'fp-ts/lib/Eq.js';
import * as O from 'fp-ts/lib/Option.js';

import { fromNullable as liftNullable } from 'fp-ts/lib/Option.js';
import * as RA from 'fp-ts/lib/ReadonlyArray.js';
import * as S from 'fp-ts/lib/string.js';
import { Lens } from 'monocle-ts';
import { iso } from 'newtype-ts';
import * as ts from 'typescript';
import { match } from 'ts-pattern';
import type {
  BindingAnnotationKind,
  BindingInfo,
  DeclarationVisibility,
  FieldInfo,
  FieldName,
  FieldNullability,
  FieldPrimitiveKind,
  ImportInfo,
  ModuleIR,
  NodeKind,
  SymbolName,
  TypeDeclInfo,
  TypeDeclKind,
  TypeFlowEdge,
  TypeFlowGraph,
  TypeFlowNode,
  TypeInspector,
  TypeSignature,
  TypeText,
} from '../model/report.js';

const isoSymbolName = iso<SymbolName>();
const isoTypeSignature = iso<TypeSignature>();
const isoFieldName = iso<FieldName>();
const isoTypeText = iso<TypeText>();

export type ExtractModuleIRInput = {
  readonly sourceFile: ts.SourceFile;
  readonly checker: ts.TypeChecker;
  readonly inspector: TypeInspector;
};

export type ExtractModuleIR = (input: ExtractModuleIRInput) => ModuleIR;

type ClassifyContext = {
  readonly sf: ts.SourceFile;
  readonly inspector: TypeInspector;
  readonly isExported: boolean;
  readonly type: ts.Type;
};

type BindingContext = {
  readonly sourceFile: ts.SourceFile;
  readonly checker: ts.TypeChecker;
  readonly inspector: TypeInspector;
  readonly isExported: boolean;
};

type EdgeContext = {
  readonly bindingName: string;
  readonly bindingNames: ReadonlyArray<string>;
};

const namedNodeText = Lens.fromPath<{ readonly name: ts.Identifier }>()(['name', 'text']);
const sourceFileStatements = Lens.fromProp<ts.SourceFile>()('statements');

const typeFlowEdgeKey = (e: TypeFlowEdge) => ({
  from: isoSymbolName.unwrap(e.from),
  to: isoSymbolName.unwrap(e.to),
  role: e.role,
});

const typeFlowEdgeEq = Eq.contramap(typeFlowEdgeKey)(
  Eq.struct({
    from: S.Eq,
    to: S.Eq,
    role: S.Eq,
  }),
);

const stepCollectNodes =
  ({ sf, tail }: { readonly sf: ts.SourceFile; readonly tail: ReadonlyArray<ts.Node> }) =>
  (head: ts.Node): readonly [ts.Node, ReadonlyArray<ts.Node>] =>
    [head, [...tail, ...head.getChildren(sf)]];

const unfoldNodes =
  (sf: ts.SourceFile) =>
  (queue: ReadonlyArray<ts.Node>): O.Option<readonly [ts.Node, ReadonlyArray<ts.Node>]> =>
    O.map(stepCollectNodes({ sf, tail: RA.dropLeft(1)(queue) }))(RA.head(queue));

const collectNodes = (sf: ts.SourceFile) => (root: ts.Node) =>
  RA.unfold([root], unfoldNodes(sf));

const isExportKeyword = (m: ts.ModifierLike) => m.kind === ts.SyntaxKind.ExportKeyword;

const getModifiersOpt = (node: ts.HasModifiers) => liftNullable(ts.getModifiers(node));

const hasExportModifier = (node: ts.HasModifiers) =>
  O.exists(RA.some(isExportKeyword))(
    O.chain(getModifiersOpt)(O.fromPredicate(ts.canHaveModifiers)(node)),
  );

const readStringLiteralText = (expr: ts.StringLiteral) => expr.text;
const readExprText = (expr: ts.Expression) => expr.getText();

const getStringLiteralText = (expr: ts.Expression) =>
  match(expr)
    .when(ts.isStringLiteral, readStringLiteralText)
    .otherwise(readExprText);

const readNamedBindingText = (spec: ts.ImportSpecifier) => namedNodeText.get(spec);

const mapNamedImports = (nb: ts.NamedImports) => RA.map(readNamedBindingText)(nb.elements);

const extractNamedImportsFromBindings = (nb: ts.NamedImportBindings) =>
  match(nb)
    .when(ts.isNamedImports, mapNamedImports)
    .otherwise(constant(RA.empty));

const extractNamedImports = (clause: ts.ImportClause) =>
  O.match(
    constant(RA.empty),
    extractNamedImportsFromBindings,
  )(liftNullable(clause.namedBindings));

const readNamespaceName = (nb: ts.NamespaceImport) => namedNodeText.get(nb);

const extractNamespaceFromBindings = (nb: ts.NamedImportBindings) =>
  O.map(readNamespaceName)(O.fromPredicate(ts.isNamespaceImport)(nb));

const extractNamespaceImport = (clause: ts.ImportClause): O.Option<string> =>
  O.chain(extractNamespaceFromBindings)(liftNullable(clause.namedBindings));

const readIdentifierText = (id: ts.Identifier) => id.text;

const readClauseDefaultImport = (c: ts.ImportClause) =>
  O.map(readIdentifierText)(liftNullable(c.name));

const readClauseIsTypeOnly = (c: ts.ImportClause) => c.isTypeOnly;

const toImportInfo = (stmt: ts.ImportDeclaration) => {
  const clauseOpt = liftNullable(stmt.importClause);
  return {
    moduleSpecifier: getStringLiteralText(stmt.moduleSpecifier),
    defaultImport: O.chain(readClauseDefaultImport)(clauseOpt),
    namespaceImport: O.chain(extractNamespaceImport)(clauseOpt),
    namedImports: O.match(constant(RA.empty), extractNamedImports)(clauseOpt),
    isTypeOnly: O.exists(readClauseIsTypeOnly)(clauseOpt),
  };
};

const extractImports = (sf: ts.SourceFile) =>
  flow(
    RA.filter(ts.isImportDeclaration),
    RA.map(toImportInfo),
  )(sourceFileStatements.get(sf));

const isBooleanType = (t: ts.Type) => (t.flags & ts.TypeFlags.BooleanLike) !== 0;

const isRawStringType = (t: ts.Type) => (t.flags & ts.TypeFlags.StringLike) !== 0;

const isRawNumberType = (t: ts.Type) => (t.flags & ts.TypeFlags.NumberLike) !== 0;

const classifyFieldKind = ({
  isNewtype,
  nonNullType,
}: {
  readonly isNewtype: boolean;
  readonly nonNullType: ts.Type;
}): FieldPrimitiveKind =>
  B.match<FieldPrimitiveKind>(
    () =>
      B.match<FieldPrimitiveKind>(
        () =>
          B.match<FieldPrimitiveKind>(
            () =>
              B.match<FieldPrimitiveKind>(
                () => 'other',
                () => 'raw-number',
              )(isRawNumberType(nonNullType)),
            () => 'raw-string',
          )(isRawStringType(nonNullType)),
        () => 'boolean',
      )(isBooleanType(nonNullType)),
    () => 'newtype',
  )(isNewtype);

const classifyNullability = ({
  isOptional,
  isNullable,
}: {
  readonly isOptional: boolean;
  readonly isNullable: boolean;
}): FieldNullability =>
  B.match<FieldNullability>(
    () =>
      B.match<FieldNullability>(
        () => 'required',
        () => 'nullable',
      )(isNullable),
    () =>
      B.match<FieldNullability>(
        () => 'optional',
        () => 'optional-nullable',
      )(isNullable),
  )(isOptional);

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
  (prop: ts.Symbol): FieldInfo => {
    const propType = checker.getTypeOfSymbolAtLocation(prop, declNode);
    const nonNullType = checker.getNonNullableType(propType);
    const isNewtype = inspector.isNewtypeBrand(nonNullType);
    const isOptional = (prop.flags & ts.SymbolFlags.Optional) !== 0;
    const isNullable = inspector.hasNullablePart(propType);
    return {
      name: isoFieldName.wrap(prop.getName()),
      typeText: isoTypeText.wrap(inspector.formatType(propType)),
      kind: classifyFieldKind({ isNewtype, nonNullType }),
      nullability: classifyNullability({ isOptional, isNullable }),
    };
  };

const isDiscriminantProp = (p: ts.Symbol) =>
  p.getName() === '_tag' || p.getName() === 'kind' || p.getName() === 'type';

const hasDiscriminantProp = (member: ts.Type) =>
  RA.some(isDiscriminantProp)(member.getProperties());

const isDiscriminatedUnionType = (type: ts.Type) =>
  type.isUnion() && RA.every(hasDiscriminantProp)(type.types);

const isTypeOrInterfaceDecl = (stmt: ts.Statement) =>
  ts.isTypeAliasDeclaration(stmt) || ts.isInterfaceDeclaration(stmt);

const getNodeVisibility = (node: ts.HasModifiers): DeclarationVisibility =>
  B.match<DeclarationVisibility>(
    () => 'private',
    () => 'exported',
  )(hasExportModifier(node));

const toTypeDeclKind = ({
  isNewtype,
  isDiscriminatedUnion,
}: {
  readonly isNewtype: boolean;
  readonly isDiscriminatedUnion: boolean;
}): TypeDeclKind =>
  B.match<TypeDeclKind>(
    () =>
      B.match<TypeDeclKind>(
        () => 'standard',
        () => 'discriminated-union',
      )(isDiscriminatedUnion),
    () => 'newtype',
  )(isNewtype);

const toTypeDeclInfo =
  ({ sourceFile, checker, inspector }: ExtractModuleIRInput) =>
  (node: ts.TypeAliasDeclaration | ts.InterfaceDeclaration): TypeDeclInfo => {
    const type = checker.getTypeAtLocation(node);
    return {
      name: namedNodeText.get(node),
      visibility: getNodeVisibility(node),
      declKind: toTypeDeclKind({
        isNewtype: inspector.isNewtypeBrand(type),
        isDiscriminatedUnion: isDiscriminatedUnionType(type),
      }),
      fields: RA.map(propertySymbolToField({ checker, inspector, declNode: node }))(
        type.getProperties(),
      ),
      location: inspector.getLocation(sourceFile)(node),
      node,
    };
  };

const extractTypeDeclarations = (input: ExtractModuleIRInput) =>
  flow(
    RA.filter(isTypeOrInterfaceDecl),
    RA.map(toTypeDeclInfo(input)),
  )(sourceFileStatements.get(input.sourceFile));

const containsTsPatternMatch = ({
  sf,
  inspector,
  expr,
}: {
  readonly sf: ts.SourceFile;
  readonly inspector: TypeInspector;
  readonly expr: ts.Expression;
}) => RA.some(inspector.isTsPatternMatch)(collectNodes(sf)(expr));

const isExportedFlowCall =
  ({ inspector, isExported }: { readonly inspector: TypeInspector; readonly isExported: boolean }) =>
  (e: ts.Expression) =>
    inspector.isFlowCall(e) && isExported;

const containsMatchPred =
  ({ sf, inspector }: { readonly sf: ts.SourceFile; readonly inspector: TypeInspector }) =>
  (e: ts.Expression) =>
    containsTsPatternMatch({ sf, inspector, expr: e });

const isExportedUnaryIdentifier =
  ({
    inspector,
    isExported,
    type,
  }: {
    readonly inspector: TypeInspector;
    readonly isExported: boolean;
    readonly type: ts.Type;
  }) =>
  (e: ts.Expression) =>
    isExported && ts.isIdentifier(e) && inspector.isUnaryFunctionType(type);

const isAtMostUnarySig = (s: ts.Signature) => s.getParameters().length <= 1;

const classifyCallExpr =
  ({ inspector, type }: { readonly inspector: TypeInspector; readonly type: ts.Type }) =>
  (e: ts.CallExpression): NodeKind =>
    B.match(
      constant<NodeKind>('other'),
      constant<NodeKind>('partial-app'),
    )(
      (inspector.isUnaryFunctionType(type) ||
        (type.getCallSignatures().length > 0 &&
          RA.every(isAtMostUnarySig)(type.getCallSignatures()))) &&
        !inspector.isFlowCall(e),
    );

const classifyInitExpr =
  ({ sf, inspector, isExported, type }: ClassifyContext) =>
  (initExpr: ts.Expression): NodeKind =>
    match(inspector.unwrapSatisfiesAndParens(initExpr))
      .when(isExportedFlowCall({ inspector, isExported }), constant<NodeKind>('exported-flow'))
      .when(inspector.isFlowCall, constant<NodeKind>('sub-flow'))
      .when(constant(inspector.isOpticType(type)), constant<NodeKind>('optic'))
      .when(
        constant(inspector.isTypeclassInstance(type)),
        constant<NodeKind>('typeclass-instance'),
      )
      .when(containsMatchPred({ sf, inspector }), constant<NodeKind>('adt-matcher'))
      .when(ts.isArrowFunction, constant<NodeKind>('leaf-fn'))
      .when(
        isExportedUnaryIdentifier({ inspector, isExported, type }),
        constant<NodeKind>('leaf-fn'),
      )
      .when(ts.isCallExpression, classifyCallExpr({ inspector, type }))
      .otherwise(constant<NodeKind>('other'));

const classifyBindingKind = ({
  sf,
  inspector,
  isExported,
  type,
  initOpt,
}: ClassifyContext & { readonly initOpt: O.Option<ts.Expression> }): NodeKind =>
  O.match(
    constant<NodeKind>('other'),
    classifyInitExpr({ sf, inspector, isExported, type }),
  )(initOpt);

const isFlowCallExpr =
  (inspector: TypeInspector) =>
  (expr: ts.Expression): expr is ts.CallExpression =>
    ts.isCallExpression(expr) && inspector.isFlowCall(expr);

const readCallArgCount = (expr: ts.CallExpression) => expr.arguments.length;

const readFlowStepCount = (inspector: TypeInspector) => (expr: ts.Expression) =>
  O.map(readCallArgCount)(
    O.fromPredicate(isFlowCallExpr(inspector))(inspector.unwrapSatisfiesAndParens(expr)),
  );

const countFlowSteps = (inspector: TypeInspector) => O.chain(readFlowStepCount(inspector));

const hasArrowReturnType = (inspector: TypeInspector) => (expr: ts.Expression) => {
  const unwrapped = inspector.unwrapSatisfiesAndParens(expr);
  return ts.isArrowFunction(unwrapped) && unwrapped.type !== undefined;
};

const hasExplicitReturnAnnotation = (inspector: TypeInspector) =>
  O.exists(hasArrowReturnType(inspector));

type IdentDeclPair = {
  readonly decl: ts.VariableDeclaration;
  readonly ident: ts.Identifier;
};

const pairDeclWithIdent =
  (decl: ts.VariableDeclaration) =>
  (ident: ts.Identifier): IdentDeclPair => ({ decl, ident });

const extractIdentDecl = (decl: ts.VariableDeclaration) =>
  O.map(pairDeclWithIdent(decl))(O.fromPredicate(ts.isIdentifier)(decl.name));

const pairSame = <A>(a: A) => [a, a] as const;

const pairParenExpr = (p: ts.ParenthesizedExpression) => pairSame(p.expression);

const stepParen = (expr: ts.Expression) =>
  O.map(pairParenExpr)(O.fromPredicate(ts.isParenthesizedExpression)(expr));

const unwrapParens = (expr: ts.Expression) =>
  O.getOrElse(constant(expr))(RA.last(RA.unfold(expr, stepParen)));

const isSatisfiesInit = flow(unwrapParens, ts.isSatisfiesExpression);

const toBindingAnnotation = ({
  hasSatisfies,
  hasExplicitReturn,
}: {
  readonly hasSatisfies: boolean;
  readonly hasExplicitReturn: boolean;
}): BindingAnnotationKind =>
  B.match<BindingAnnotationKind>(
    () =>
      B.match<BindingAnnotationKind>(
        () => 'none',
        () => 'explicit-return',
      )(hasExplicitReturn),
    () =>
      B.match<BindingAnnotationKind>(
        () => 'satisfies',
        () => 'both',
      )(hasExplicitReturn),
  )(hasSatisfies);

const buildIdentBinding =
  ({
    sourceFile,
    checker,
    inspector,
    stmt,
    isExported,
  }: BindingContext & { readonly stmt: ts.VariableStatement }) =>
  ({ decl, ident }: IdentDeclPair): ReadonlyArray<BindingInfo> => {
    const initOpt = liftNullable(decl.initializer);
    const type = checker.getTypeAtLocation(decl);
    const hasSatisfies = O.exists(isSatisfiesInit)(initOpt);
    const hasExplicitReturn =
      decl.type !== undefined || hasExplicitReturnAnnotation(inspector)(initOpt);
    return [
      {
        name: isoSymbolName.wrap(ident.text),
        visibility: getNodeVisibility(stmt),
        kind: classifyBindingKind({ sf: sourceFile, inspector, isExported, type, initOpt }),
        annotation: toBindingAnnotation({ hasSatisfies, hasExplicitReturn }),
        signature: isoTypeSignature.wrap(inspector.formatType(type)),
        effects: inspector.detectEffects(type),
        stepCount: countFlowSteps(inspector)(initOpt),
        location: inspector.getLocation(sourceFile)(decl),
        declaration: decl,
        statement: stmt,
        initializer: initOpt,
      },
    ];
  };

const buildBindingFromDecl =
  (ctx: BindingContext & { readonly stmt: ts.VariableStatement }) =>
  (decl: ts.VariableDeclaration): ReadonlyArray<BindingInfo> =>
    O.match(
      constant(RA.empty),
      buildIdentBinding(ctx),
    )(extractIdentDecl(decl));

const statementToBindings =
  ({ sourceFile, checker, inspector }: ExtractModuleIRInput) =>
  (stmt: ts.VariableStatement): ReadonlyArray<BindingInfo> =>
    RA.chain(
      buildBindingFromDecl({
        sourceFile,
        checker,
        inspector,
        stmt,
        isExported: hasExportModifier(stmt),
      }),
    )(stmt.declarationList.declarations);

const extractBindings = (input: ExtractModuleIRInput) =>
  flow(
    RA.filter(ts.isVariableStatement),
    RA.chain(statementToBindings(input)),
  )(sourceFileStatements.get(input.sourceFile));

const isFlowStepArg =
  (bindingNames: ReadonlyArray<string>) =>
  (arg: ts.Expression): arg is ts.Identifier =>
    ts.isIdentifier(arg) && RA.elem(S.Eq)(arg.text)(bindingNames);

const toFlowStepEdge =
  (bindingName: string) =>
  (arg: ts.Identifier): TypeFlowEdge => ({
    from: isoSymbolName.wrap(bindingName),
    to: isoSymbolName.wrap(arg.text),
    role: 'flow-step',
  });

const extractFlowStepEdge =
  ({ bindingName, bindingNames }: EdgeContext) =>
  (arg: ts.Expression) =>
    O.map(toFlowStepEdge(bindingName))(O.fromPredicate(isFlowStepArg(bindingNames))(arg));

const isUsedBindingId =
  ({ bindingName, bindingNames }: EdgeContext) =>
  (n: ts.Node): n is ts.Identifier =>
    ts.isIdentifier(n) && n.text !== bindingName && RA.elem(S.Eq)(n.text)(bindingNames);

const toUsesEdge =
  (bindingName: string) =>
  (id: ts.Identifier): TypeFlowEdge => ({
    from: isoSymbolName.wrap(bindingName),
    to: isoSymbolName.wrap(id.text),
    role: 'uses',
  });

const extractUsesEdge =
  (ctx: EdgeContext) =>
  (n: ts.Node) =>
    O.map(toUsesEdge(ctx.bindingName))(O.fromPredicate(isUsedBindingId(ctx))(n));

const collectCallFlowEdges =
  (ctx: EdgeContext) =>
  (call: ts.CallExpression): ReadonlyArray<TypeFlowEdge> =>
    RA.filterMap(extractFlowStepEdge(ctx))(call.arguments);

const collectFlowArgEdges =
  (ctx: EdgeContext) =>
  (unwrapped: ts.Expression): ReadonlyArray<TypeFlowEdge> =>
    match(unwrapped)
      .when(ts.isCallExpression, collectCallFlowEdges(ctx))
      .otherwise(constant(RA.empty));

const extractEdgesFromInit =
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
  (expr: ts.Expression): ReadonlyArray<TypeFlowEdge> => {
    const unwrapped = inspector.unwrapSatisfiesAndParens(expr);
    const isFlow = isFlowCallExpr(inspector)(unwrapped);
    const ctx = { bindingName, bindingNames };
    const flowArgIds = B.match(
      constant(RA.empty),
      () => collectFlowArgEdges(ctx)(unwrapped),
    )(isFlow);
    const allIds = RA.filterMap(extractUsesEdge(ctx))(collectNodes(sf)(unwrapped));
    return RA.uniq(typeFlowEdgeEq)([...flowArgIds, ...allIds]);
  };

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
  (binding: BindingInfo): ReadonlyArray<TypeFlowEdge> =>
    O.match(
      constant(RA.empty),
      extractEdgesFromInit({
        sf,
        inspector,
        bindingName: isoSymbolName.unwrap(binding.name),
        bindingNames,
      }),
    )(binding.initializer);

const toTypeFlowNode = (b: BindingInfo) => ({
  name: b.name,
  kind: b.kind,
  signature: b.signature,
  effects: b.effects,
  stepCount: b.stepCount,
});

const readBindingName = (b: BindingInfo) => isoSymbolName.unwrap(b.name);

const buildModuleIR = (input: ExtractModuleIRInput) => {
  const { sourceFile, inspector } = input;
  const imports = extractImports(sourceFile);
  const typeDeclarations = extractTypeDeclarations(input);
  const bindings = extractBindings(input);
  const bindingNames = RA.map(readBindingName)(bindings);
  const edges = RA.chain(extractEdgesForBinding({ sf: sourceFile, inspector, bindingNames }))(
    bindings,
  );
  const typeFlowGraph: TypeFlowGraph = {
    nodes: RA.map(toTypeFlowNode)(bindings),
    edges,
  };
  return {
    filePath: sourceFile.fileName,
    imports,
    typeDeclarations,
    bindings,
    edges,
    typeFlowGraph,
  };
};

const passInput = (input: ExtractModuleIRInput) => input;

export const extractModuleIR = flow(
  passInput,
  buildModuleIR,
) satisfies ExtractModuleIR;
