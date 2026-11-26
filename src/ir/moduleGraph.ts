import { constant, flow } from 'fp-ts/lib/function.js';
import * as B from 'fp-ts/lib/boolean.js';
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
  TypeFlowGraph,
  TypeFlowNode,
  TypeInspector,
} from '../model/report.js';

export type ExtractModuleIRInput = {
  readonly sourceFile: ts.SourceFile;
  readonly checker: ts.TypeChecker;
  readonly inspector: TypeInspector;
};

export type ExtractModuleIR = (input: ExtractModuleIRInput) => ModuleIR;

const collectNodes = (_sf: ts.SourceFile) => (root: ts.Node): ReadonlyArray<ts.Node> => {
  const out: ts.Node[] = [];
  const visit = (n: ts.Node): void => {
    out.push(n);
    ts.forEachChild(n, visit);
  };
  visit(root);
  return out;
};

const hasExportModifier = (node: ts.HasModifiers): boolean =>
  O.exists(
    RA.some((m: ts.ModifierLike) => m.kind === ts.SyntaxKind.ExportKeyword),
  )(O.fromNullable(ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined));

const getStringLiteralText = (expr: ts.Expression): string =>
  ts.isStringLiteral(expr) ? expr.text : expr.getText();

const readNamedBindingText = (spec: ts.ImportSpecifier): string => spec.name.text;

const extractNamedImports = (clause: ts.ImportClause): ReadonlyArray<string> =>
  O.match(
    constant([] as ReadonlyArray<string>),
    (nb: ts.NamedImportBindings) =>
      ts.isNamedImports(nb)
        ? RA.map(readNamedBindingText)(nb.elements)
        : ([] as ReadonlyArray<string>),
  )(O.fromNullable(clause.namedBindings));

const extractNamespaceImport = (clause: ts.ImportClause): O.Option<string> =>
  O.chain((nb: ts.NamedImportBindings) =>
    ts.isNamespaceImport(nb) ? O.some(nb.name.text) : O.none,
  )(O.fromNullable(clause.namedBindings));

const toImportInfo = (stmt: ts.ImportDeclaration): ImportInfo => ({
  moduleSpecifier: getStringLiteralText(stmt.moduleSpecifier),
  defaultImport: O.chain((c: ts.ImportClause) =>
    O.map((id: ts.Identifier) => id.text)(O.fromNullable(c.name)),
  )(O.fromNullable(stmt.importClause)),
  namespaceImport: O.chain(extractNamespaceImport)(O.fromNullable(stmt.importClause)),
  namedImports: O.match(
    constant([] as ReadonlyArray<string>),
    extractNamedImports,
  )(O.fromNullable(stmt.importClause)),
  isTypeOnly: O.exists((c: ts.ImportClause) => c.isTypeOnly)(O.fromNullable(stmt.importClause)),
});

const extractImports = (sf: ts.SourceFile): ReadonlyArray<ImportInfo> =>
  flow(
    RA.filter(ts.isImportDeclaration),
    RA.map(toImportInfo),
  )(sf.statements);

const isBooleanType = (t: ts.Type): boolean =>
  (t.flags & ts.TypeFlags.BooleanLike) !== 0;

const isRawStringType = (t: ts.Type): boolean =>
  (t.flags & ts.TypeFlags.StringLike) !== 0;

const isRawNumberType = (t: ts.Type): boolean =>
  (t.flags & ts.TypeFlags.NumberLike) !== 0;

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
    return {
      name: prop.getName(),
      typeText: inspector.formatType(propType),
      isBoolean: isBooleanType(nonNullType),
      isOptional: (prop.flags & ts.SymbolFlags.Optional) !== 0,
      isNullable: inspector.hasNullablePart(propType),
      isRawString: !isNewtype && isRawStringType(nonNullType),
      isRawNumber: !isNewtype && isRawNumberType(nonNullType),
      isNewtype,
    };
  };

const isDiscriminatedUnionType = (type: ts.Type): boolean =>
  type.isUnion() &&
  RA.every((member: ts.Type) =>
    RA.some((p: ts.Symbol) => p.getName() === '_tag' || p.getName() === 'kind' || p.getName() === 'type')(
      member.getProperties(),
    ),
  )(type.types);

const isTypeOrInterfaceDecl = (
  stmt: ts.Statement,
): stmt is ts.TypeAliasDeclaration | ts.InterfaceDeclaration =>
  ts.isTypeAliasDeclaration(stmt) || ts.isInterfaceDeclaration(stmt);

const toTypeDeclInfo =
  ({ sourceFile, checker, inspector }: ExtractModuleIRInput) =>
  (node: ts.TypeAliasDeclaration | ts.InterfaceDeclaration): TypeDeclInfo => {
    const type = checker.getTypeAtLocation(node);
    return {
      name: node.name.text,
      isExported: hasExportModifier(node),
      isNewtype: inspector.isNewtypeBrand(type),
      isDiscriminatedUnion: isDiscriminatedUnionType(type),
      fields: RA.map(propertySymbolToField({ checker, inspector, declNode: node }))(
        type.getProperties(),
      ),
      location: inspector.getLocation(sourceFile)(node),
      node,
    };
  };

const extractTypeDeclarations = (input: ExtractModuleIRInput): ReadonlyArray<TypeDeclInfo> =>
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
}): boolean => RA.some(inspector.isTsPatternMatch)(collectNodes(sf)(expr));

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
}): NodeKind =>
  O.match(
    constant<NodeKind>('other'),
    (initExpr: ts.Expression): NodeKind => {
      const unwrapped = inspector.unwrapSatisfiesAndParens(initExpr);
      return match(unwrapped)
        .when(
          (e) => inspector.isFlowCall(e) && isExported,
          constant<NodeKind>('exported-flow'),
        )
        .when(inspector.isFlowCall, constant<NodeKind>('sub-flow'))
        .when(constant(inspector.isOpticType(type)), constant<NodeKind>('optic'))
        .when(
          constant(inspector.isTypeclassInstance(type)),
          constant<NodeKind>('typeclass-instance'),
        )
        .when(
          (e) => containsTsPatternMatch({ sf, inspector, expr: e }),
          constant<NodeKind>('adt-matcher'),
        )
        .when(ts.isArrowFunction, constant<NodeKind>('leaf-fn'))
        .when(
          (e) => isExported && ts.isIdentifier(e) && inspector.isUnaryFunctionType(type),
          constant<NodeKind>('leaf-fn'),
        )
        .when(ts.isCallExpression, (e) =>
          (inspector.isUnaryFunctionType(type) ||
            (type.getCallSignatures().length > 0 &&
              RA.every((s: ts.Signature) => s.getParameters().length <= 1)(
                type.getCallSignatures(),
              ))) &&
          !inspector.isFlowCall(e)
            ? 'partial-app'
            : 'other',
        )
        .otherwise(constant<NodeKind>('other'));
    },
  )(initOpt);

const countFlowSteps = (inspector: TypeInspector) => (initOpt: O.Option<ts.Expression>): O.Option<number> =>
  O.chain((expr: ts.Expression) => {
    const unwrapped = inspector.unwrapSatisfiesAndParens(expr);
    return ts.isCallExpression(unwrapped) && inspector.isFlowCall(unwrapped)
      ? O.some(unwrapped.arguments.length)
      : O.none;
  })(initOpt);

const hasExplicitReturnAnnotation =
  (inspector: TypeInspector) =>
  (initOpt: O.Option<ts.Expression>): boolean =>
    O.exists((expr: ts.Expression) => {
      const unwrapped = inspector.unwrapSatisfiesAndParens(expr);
      return ts.isArrowFunction(unwrapped) && unwrapped.type !== undefined;
    })(initOpt);

const statementToBindings =
  ({ sourceFile, checker, inspector }: ExtractModuleIRInput) =>
  (stmt: ts.VariableStatement): ReadonlyArray<BindingInfo> => {
    const isExported = hasExportModifier(stmt);
    return RA.chain((decl: ts.VariableDeclaration): ReadonlyArray<BindingInfo> => {
      if (!ts.isIdentifier(decl.name)) {
        return [];
      }
      const initOpt = O.fromNullable(decl.initializer);
      const type = checker.getTypeAtLocation(decl);
      const hasSatisfies = O.exists(ts.isSatisfiesExpression)(initOpt);
      const hasExplicitReturn =
        decl.type !== undefined || hasExplicitReturnAnnotation(inspector)(initOpt);
      return [
        {
          name: decl.name.text,
          isExported,
          kind: classifyBindingKind({ sf: sourceFile, inspector, isExported, type, initOpt }),
          hasSatisfies,
          hasExplicitReturnType: hasExplicitReturn,
          signature: inspector.formatType(type),
          effects: inspector.detectEffects(type),
          stepCount: countFlowSteps(inspector)(initOpt),
          location: inspector.getLocation(sourceFile)(decl),
          declaration: decl,
          statement: stmt,
          initializer: initOpt,
        },
      ];
    })(stmt.declarationList.declarations);
  };

const extractBindings = (input: ExtractModuleIRInput): ReadonlyArray<BindingInfo> =>
  flow(
    RA.filter(ts.isVariableStatement),
    RA.chain(statementToBindings(input)),
  )(input.sourceFile.statements);

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
      constant([] as ReadonlyArray<TypeFlowEdge>),
      (expr: ts.Expression) => {
        const unwrapped = inspector.unwrapSatisfiesAndParens(expr);
        const isFlow = ts.isCallExpression(unwrapped) && inspector.isFlowCall(unwrapped);
        const flowArgIds = isFlow
          ? RA.filterMap((arg: ts.Expression) =>
              ts.isIdentifier(arg) && RA.elem(S.Eq)(arg.text)(bindingNames)
                ? O.some<TypeFlowEdge>({ from: binding.name, to: arg.text, role: 'flow-step' })
                : O.none,
            )(unwrapped.arguments)
          : ([] as ReadonlyArray<TypeFlowEdge>);
        const allIds = RA.filterMap((n: ts.Node) =>
          ts.isIdentifier(n) &&
          n.text !== binding.name &&
          RA.elem(S.Eq)(n.text)(bindingNames)
            ? O.some<TypeFlowEdge>({ from: binding.name, to: n.text, role: 'uses' })
            : O.none,
        )(collectNodes(sf)(unwrapped));
        return RA.uniq({
          equals: (a: TypeFlowEdge, b: TypeFlowEdge) =>
            a.from === b.from && a.to === b.to && a.role === b.role,
        })([...flowArgIds, ...allIds]);
      },
    )(binding.initializer);

const toTypeFlowNode = (b: BindingInfo): TypeFlowNode => ({
  name: b.name,
  kind: b.kind,
  signature: b.signature,
  effects: b.effects,
  stepCount: b.stepCount,
});

const buildModuleIR = (input: ExtractModuleIRInput): ModuleIR => {
  const { sourceFile, inspector } = input;
  const imports = extractImports(sourceFile);
  const typeDeclarations = extractTypeDeclarations(input);
  const bindings = extractBindings(input);
  const bindingNames = RA.map((b: BindingInfo) => b.name)(bindings);
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
