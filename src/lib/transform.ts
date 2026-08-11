import { createRequire } from 'node:module';
import path from 'node:path';
import { parseSync, transformSync } from '@swc/core';
import MagicString from 'magic-string';
import type { PluginOptions } from '../types';

const toJsonSchemaPackageName = '@valibot/to-json-schema';

type AstNode = {
  type: string;
  span?: { start: number; end: number };
  [key: string]: any;
};

type Binding = {
  value: AstNode;
  declaration: AstNode;
  name: string;
};

type ImportBinding = {
  declaration: AstNode;
  localName: string;
};

export type ValibotJsonSchemaTransformResult = {
  code: string;
  map: unknown;
};

type SourceReader = {
  start: (node: AstNode) => number;
  end: (node: AstNode) => number;
  slice: (node: AstNode) => string;
  position: (node: AstNode) => { line: number; column: number };
};

function toUtf8ByteLength(codePoint: number): number {
  if (codePoint <= 0x7f) {
    return 1;
  }

  if (codePoint <= 0x7ff) {
    return 2;
  }

  if (codePoint <= 0xffff) {
    return 3;
  }

  return 4;
}

function createSourceReader(code: string): SourceReader {
  const byteLength = Buffer.byteLength(code, 'utf8');
  const byteToIndex = new Uint32Array(byteLength + 1);
  let bytePos = 0;

  for (let index = 0; index < code.length; ) {
    const codePoint = code.codePointAt(index) ?? 0;

    for (let offset = 0; offset < toUtf8ByteLength(codePoint); offset++) {
      byteToIndex[bytePos + offset] = index;
    }

    bytePos += toUtf8ByteLength(codePoint);
    index += codePoint > 0xffff ? 2 : 1;
  }

  byteToIndex[byteLength] = code.length;

  const startIndex = (node: AstNode): number => byteToIndex[(node.span?.start ?? 0) - 1];
  const endIndex = (node: AstNode): number => byteToIndex[(node.span?.end ?? 0) - 1];

  return {
    start: startIndex,
    end: endIndex,
    slice: (node) => code.slice(startIndex(node), endIndex(node)),
    position: (node) => {
      const index = startIndex(node);
      let line = 1;
      let column = 1;

      for (let cursor = 0; cursor < index; cursor++) {
        if (code[cursor] === '\n') {
          line++;
          column = 1;
        } else {
          column++;
        }
      }

      return { line, column };
    },
  };
}

export async function transformValibotJsonSchema(
  code: string,
  id: string,
  options?: PluginOptions
): Promise<ValibotJsonSchemaTransformResult | null> {
  if (!code.includes(toJsonSchemaPackageName) || !code.includes('toJsonSchema')) {
    return null;
  }

  if (options?.include && !options.include.test(id)) {
    return null;
  }

  if (options?.exclude?.test(id)) {
    return null;
  }

  const reader = createSourceReader(code);
  const ast = parseSync(code, {
    syntax: 'typescript',
    tsx: /\.[jt]sx$/.test(id),
    decorators: true,
  }) as unknown as AstNode;

  const toJsonSchemaLocals = getToJsonSchemaLocals(ast);

  if (toJsonSchemaLocals.size === 0) {
    return null;
  }

  const replacements: { start: number; end: number; value: string }[] = [];
  const replacedToJsonSchemaLocals = new Set<string>();
  const failedToJsonSchemaLocals = new Set<string>();

  walkWithAncestors(ast, (node, ancestors) => {
    if (node.type !== 'CallExpression') {
      return;
    }

    if (node.callee?.type !== 'Identifier' || !toJsonSchemaLocals.has(node.callee.value)) {
      return;
    }

    const toJsonSchemaArgs = node.arguments ?? [];
    const schemaArg = toJsonSchemaArgs[0]?.expression;

    if (!schemaArg) {
      failedToJsonSchemaLocals.add(node.callee.value);
      reportTransformError(id, reader, node, new Error('toJsonSchema call without a schema argument'));
      return;
    }

    let jsonSchema: unknown;

    try {
      jsonSchema = evaluateSchema(
        code,
        reader,
        id,
        toJsonSchemaArgs,
        getAvailableBindings(ast, node, ancestors),
        getImportBindings(ast)
      );
    } catch (error) {
      failedToJsonSchemaLocals.add(node.callee.value);
      reportTransformError(id, reader, node, error);
      return;
    }

    replacedToJsonSchemaLocals.add(node.callee.value);
    replacements.push({
      start: reader.start(node),
      end: reader.end(node),
      value: JSON.stringify(jsonSchema, null, 2),
    });
  });

  if (replacements.length === 0) {
    return null;
  }

  const magicString = new MagicString(code);

  for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
    magicString.overwrite(replacement.start, replacement.end, replacement.value);
  }

  removeToJsonSchemaImportIfUnused(code, reader, ast, replacedToJsonSchemaLocals, failedToJsonSchemaLocals, magicString);

  return {
    code: magicString.toString(),
    map: magicString.generateMap({ hires: true }),
  };
}

function reportTransformError(id: string, reader: SourceReader, node: AstNode, error: unknown): void {
  const { line, column } = reader.position(node);
  const detail = error instanceof Error ? ` ${error.message}` : '';

  console.error(
    `[unplugin-valibot-to-json-schema] Failed to convert schema to JSON Schema at ${id}:${line}:${column}. The toJsonSchema call is left unchanged.${detail}`
  );
}

function getToJsonSchemaLocals(ast: AstNode): Set<string> {
  const locals = new Set<string>();

  for (const node of ast.body ?? []) {
    if (node.type !== 'ImportDeclaration' || node.source?.value !== toJsonSchemaPackageName) {
      continue;
    }

    for (const specifier of node.specifiers ?? []) {
      if (specifier.type !== 'ImportSpecifier') {
        continue;
      }

      const imported = specifier.imported;

      if (imported !== null && imported?.value !== 'toJsonSchema') {
        continue;
      }

      locals.add(specifier.local?.value ?? 'toJsonSchema');
    }
  }

  return locals;
}

function getAvailableBindings(ast: AstNode, callExpression: AstNode, ancestors: AstNode[]): Map<string, Binding> {
  const bindings = new Map<string, Binding>();
  const scopeNodes = [ast, ...ancestors.filter((node) => node.type === 'BlockStatement')];

  for (const scopeNode of scopeNodes) {
    const statements = scopeNode.type === 'BlockStatement' ? scopeNode.stmts : scopeNode.body;

    for (const statement of statements ?? []) {
      if (statement.span?.start > (callExpression.span?.start ?? 0)) {
        continue;
      }

      collectStatementBindings(statement, bindings);
    }
  }

  return bindings;
}

function collectStatementBindings(statement: AstNode, bindings: Map<string, Binding>): void {
  const declaration = statement.type === 'ExportDeclaration' ? statement.declaration : statement;

  if (!declaration) {
    return;
  }

  if (declaration.type === 'VariableDeclaration' && declaration.kind === 'const') {
    for (const variableDeclarator of declaration.declarations ?? []) {
      if (variableDeclarator.id?.type === 'Identifier' && variableDeclarator.init) {
        bindings.set(variableDeclarator.id.value, {
          name: variableDeclarator.id.value,
          value: variableDeclarator.init,
          declaration: statement,
        });
      }
    }
  }

  if (declaration.type === 'FunctionDeclaration' && declaration.identifier?.type === 'Identifier') {
    bindings.set(declaration.identifier.value, {
      name: declaration.identifier.value,
      value: declaration.body,
      declaration: statement,
    });
  }
}

function evaluateSchema(
  code: string,
  reader: SourceReader,
  id: string,
  toJsonSchemaArgs: AstNode[],
  bindings: Map<string, Binding>,
  importBindings: ImportBinding[]
): unknown {
  const neededBindings = new Set<Binding>();
  const referencedIdentifiers = new Set<string>();
  const argExpressions = toJsonSchemaArgs.map((arg) => arg.expression).filter(Boolean);

  for (const expression of argExpressions) {
    for (const binding of collectNeededBindings(expression, bindings)) {
      neededBindings.add(binding);
    }

    for (const identifier of collectReferencedIdentifiers(expression)) {
      referencedIdentifiers.add(identifier);
    }
  }

  for (const binding of neededBindings) {
    for (const identifier of collectReferencedIdentifiers(binding.value)) {
      referencedIdentifiers.add(identifier);
    }
  }

  const importDeclarations = getNeededImportDeclarations(code, reader, importBindings, referencedIdentifiers);
  const declarations = Array.from(neededBindings)
    .sort((a, b) => (a.declaration.span?.start ?? 0) - (b.declaration.span?.start ?? 0))
    .map((binding) => reader.slice(binding.declaration))
    .join('\n');
  const toJsonSchemaArgsExpression = argExpressions.map((expression) => reader.slice(expression)).join(', ');
  const source = [
    ...importDeclarations,
    "import { toJsonSchema } from '@valibot/to-json-schema';",
    declarations,
    `export default toJsonSchema(${toJsonSchemaArgsExpression});`,
  ].join('\n');

  const commonJs = transformSync(source, {
    filename: id,
    jsc: {
      parser: {
        syntax: 'typescript',
        tsx: /\.[jt]sx$/.test(id),
        decorators: true,
      },
      target: 'es2022',
    },
    module: {
      type: 'commonjs',
    },
  }).code;

  const module = { exports: {} as Record<string, unknown> };
  const requireFromSource = createEvaluatorRequire(id);
  const execute = new Function('require', 'module', 'exports', commonJs);

  execute(requireFromSource, module, module.exports);

  return module.exports.default;
}

function createEvaluatorRequire(id: string): NodeRequire {
  const sourceRequire = createRequire(path.resolve(id));
  const cwdRequire = createRequire(path.join(process.cwd(), 'package.json'));

  return ((request: string) => {
    try {
      return sourceRequire(request);
    } catch (error) {
      if (!isCannotFindRequestedModule(error, request)) {
        throw error;
      }

      return cwdRequire(request);
    }
  }) as NodeRequire;
}

function isCannotFindRequestedModule(error: unknown, request: string): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    error.code === 'MODULE_NOT_FOUND' &&
    error.message.includes(`'${request}'`)
  );
}

function collectNeededBindings(node: AstNode, bindings: Map<string, Binding>, visited = new Set<string>()): Set<Binding> {
  const result = new Set<Binding>();
  const identifiers = collectReferencedIdentifiers(node);

  for (const identifier of identifiers) {
    if (visited.has(identifier)) {
      continue;
    }

    const dependency = bindings.get(identifier);

    if (!dependency) {
      continue;
    }

    visited.add(identifier);
    for (const nested of collectNeededBindings(dependency.value, bindings, visited)) {
      result.add(nested);
    }
    result.add(dependency);
  }

  return result;
}

function collectReferencedIdentifiers(node: AstNode): Set<string> {
  const identifiers = new Set<string>();

  walk(node, (current, parent) => {
    if (current.type !== 'Identifier') {
      return;
    }

    if (parent?.type === 'MemberExpression' && parent.property === current && !parent.computed) {
      return;
    }

    if ((parent?.type === 'KeyValueProperty' || parent?.type === 'AssignmentPatternProperty') && parent.key === current) {
      return;
    }

    if (parent?.type === 'VariableDeclarator' && parent.id === current) {
      return;
    }

    if (
      (parent?.type === 'FunctionDeclaration' || parent?.type === 'FunctionExpression') &&
      parent.identifier === current
    ) {
      return;
    }

    if (parent?.type === 'Parameter' && parent.pat === current) {
      return;
    }

    identifiers.add(current.value);
  });

  return identifiers;
}

function getImportBindings(ast: AstNode): ImportBinding[] {
  const importBindings: ImportBinding[] = [];

  for (const node of ast.body ?? []) {
    if (node.type !== 'ImportDeclaration' || node.source?.value === toJsonSchemaPackageName) {
      continue;
    }

    for (const specifier of node.specifiers ?? []) {
      if (specifier.type === 'ImportSpecifier' || specifier.type === 'ImportDefaultSpecifier' || specifier.type === 'ImportNamespaceSpecifier') {
        importBindings.push({
          declaration: node,
          localName: specifier.local.value,
        });
      }
    }
  }

  return importBindings;
}

function getNeededImportDeclarations(
  code: string,
  reader: SourceReader,
  importBindings: ImportBinding[],
  referencedIdentifiers: Set<string>
): string[] {
  const importDeclarations = new Map<number, AstNode>();

  for (const importBinding of importBindings) {
    if (referencedIdentifiers.has(importBinding.localName)) {
      importDeclarations.set(importBinding.declaration.span?.start ?? 0, importBinding.declaration);
    }
  }

  return Array.from(importDeclarations.values())
    .sort((a, b) => (a.span?.start ?? 0) - (b.span?.start ?? 0))
    .map((node) => reader.slice(node));
}

function removeToJsonSchemaImportIfUnused(
  code: string,
  reader: SourceReader,
  ast: AstNode,
  replacedLocals: Set<string>,
  failedLocals: Set<string>,
  magicString: MagicString
): void {
  for (const node of ast.body ?? []) {
    if (node.type !== 'ImportDeclaration' || node.source?.value !== toJsonSchemaPackageName) {
      continue;
    }

    const removableSpecifiers = node.specifiers?.filter(
      (specifier: AstNode) =>
        specifier.type === 'ImportSpecifier' && replacedLocals.has(specifier.local?.value) && !failedLocals.has(specifier.local?.value)
    );

    if (removableSpecifiers.length === node.specifiers.length) {
      const end = code[reader.end(node)] === '\n' ? reader.end(node) + 1 : reader.end(node);
      magicString.remove(reader.start(node), end);
    }
  }
}

function getChildNodes(value: unknown): AstNode[] {
  const children: AstNode[] = [];

  if (Array.isArray(value)) {
    for (const item of value) {
      if (!item || typeof item !== 'object') {
        continue;
      }

      const node = item as AstNode;

      if (node.type) {
        children.push(node);
      } else if (node.expression?.type) {
        children.push(node.expression);
      }
    }

    return children;
  }

  if (value && typeof value === 'object') {
    const node = value as AstNode;

    if (node.type) {
      children.push(node);
    } else if (node.expression?.type) {
      children.push(node.expression);
    }
  }

  return children;
}

function walk(node: AstNode, visit: (node: AstNode, parent?: AstNode) => void, parent?: AstNode): void {
  visit(node, parent);

  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'start' || key === 'end') {
      continue;
    }

    for (const child of getChildNodes(node[key])) {
      walk(child, visit, node);
    }
  }
}

function walkWithAncestors(node: AstNode, visit: (node: AstNode, ancestors: AstNode[]) => void, ancestors: AstNode[] = []): void {
  visit(node, ancestors);

  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'start' || key === 'end') {
      continue;
    }

    for (const child of getChildNodes(node[key])) {
      walkWithAncestors(child, visit, ancestors.concat(node));
    }
  }
}