import { createRequire } from 'node:module';
import path from 'node:path';
import { parse } from '@babel/parser';
import { transformSync } from '@swc/core';
import MagicString from 'magic-string';
import type { PluginOptions } from '../types';

const toJsonSchemaPackageName = '@valibot/to-json-schema';

type AstNode = {
  type: string;
  start: number;
  end: number;
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

  const ast = parse(code, {
    sourceType: 'module',
    plugins: ['typescript', 'jsx', 'decorators-legacy'],
  }) as unknown as AstNode;

  const program = ast.program as AstNode;
  const toJsonSchemaLocals = getToJsonSchemaLocals(program);

  if (toJsonSchemaLocals.size === 0) {
    return null;
  }

  const replacements: { start: number; end: number; value: string }[] = [];

  walkWithAncestors(program, (node, ancestors) => {
    if (node.type !== 'CallExpression') {
      return;
    }

    if (node.callee?.type !== 'Identifier' || !toJsonSchemaLocals.has(node.callee.name)) {
      return;
    }

    const toJsonSchemaArgs = node.arguments ?? [];
    const schemaArg = toJsonSchemaArgs[0];

    if (!schemaArg) {
      throw new Error(`toJsonSchema call without a schema argument cannot be compiled in ${id}`);
    }

    const jsonSchema = evaluateSchema(
      code,
      id,
      toJsonSchemaArgs,
      getAvailableBindings(program, node, ancestors),
      getImportBindings(program)
    );
    replacements.push({
      start: node.start,
      end: node.end,
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

  removeToJsonSchemaImportIfUnused(code, program, toJsonSchemaLocals, magicString);

  return {
    code: magicString.toString(),
    map: magicString.generateMap({ hires: true }),
  };
}

function getToJsonSchemaLocals(program: AstNode): Set<string> {
  const locals = new Set<string>();

  for (const node of program.body ?? []) {
    if (node.type !== 'ImportDeclaration' || node.source?.value !== toJsonSchemaPackageName) {
      continue;
    }

    for (const specifier of node.specifiers ?? []) {
      if (specifier.type !== 'ImportSpecifier' || specifier.imported?.name !== 'toJsonSchema') {
        continue;
      }

      locals.add(specifier.local?.name ?? 'toJsonSchema');
    }
  }

  return locals;
}

function getAvailableBindings(program: AstNode, callExpression: AstNode, ancestors: AstNode[]): Map<string, Binding> {
  const bindings = new Map<string, Binding>();
  const scopeNodes = [program, ...ancestors.filter((node) => node.type === 'BlockStatement')];

  for (const scopeNode of scopeNodes) {
    for (const statement of scopeNode.body ?? []) {
      if (statement.start > callExpression.start) {
        continue;
      }

      collectStatementBindings(statement, bindings);
    }
  }

  return bindings;
}

function collectStatementBindings(statement: AstNode, bindings: Map<string, Binding>): void {
  const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;

  if (!declaration) {
    return;
  }

  if (declaration.type === 'VariableDeclaration' && declaration.kind === 'const') {
    for (const variableDeclarator of declaration.declarations ?? []) {
      if (variableDeclarator.id?.type === 'Identifier' && variableDeclarator.init) {
        bindings.set(variableDeclarator.id.name, {
          name: variableDeclarator.id.name,
          value: variableDeclarator.init,
          declaration: statement,
        });
      }
    }
  }

  if (declaration.type === 'FunctionDeclaration' && declaration.id?.type === 'Identifier') {
    bindings.set(declaration.id.name, {
      name: declaration.id.name,
      value: declaration.body,
      declaration: statement,
    });
  }
}

function evaluateSchema(
  code: string,
  id: string,
  toJsonSchemaArgs: AstNode[],
  bindings: Map<string, Binding>,
  importBindings: ImportBinding[]
): unknown {
  const neededBindings = new Set<Binding>();
  const referencedIdentifiers = new Set<string>();

  for (const arg of toJsonSchemaArgs) {
    for (const binding of collectNeededBindings(arg, bindings)) {
      neededBindings.add(binding);
    }

    for (const identifier of collectReferencedIdentifiers(arg)) {
      referencedIdentifiers.add(identifier);
    }
  }

  for (const binding of neededBindings) {
    for (const identifier of collectReferencedIdentifiers(binding.value)) {
      referencedIdentifiers.add(identifier);
    }
  }

  const importDeclarations = getNeededImportDeclarations(code, importBindings, referencedIdentifiers);
  const declarations = Array.from(neededBindings)
    .sort((a, b) => a.declaration.start - b.declaration.start)
    .map((binding) => code.slice(binding.declaration.start, binding.declaration.end))
    .join('\n');
  const toJsonSchemaArgsExpression = toJsonSchemaArgs.map((arg) => code.slice(arg.start, arg.end)).join(', ');
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

    if (parent?.type === 'ObjectProperty' && parent.key === current && !parent.computed) {
      return;
    }

    if (parent?.type === 'VariableDeclarator' && parent.id === current) {
      return;
    }

    if ((parent?.type === 'FunctionDeclaration' || parent?.type === 'FunctionExpression') && parent.id === current) {
      return;
    }

    if (
      (parent?.type === 'FunctionDeclaration' || parent?.type === 'FunctionExpression' || parent?.type === 'ArrowFunctionExpression') &&
      parent.params?.includes(current)
    ) {
      return;
    }

    identifiers.add(current.name);
  });

  return identifiers;
}

function getImportBindings(program: AstNode): ImportBinding[] {
  const importBindings: ImportBinding[] = [];

  for (const node of program.body ?? []) {
    if (node.type !== 'ImportDeclaration' || node.source?.value === toJsonSchemaPackageName) {
      continue;
    }

    for (const specifier of node.specifiers ?? []) {
      if (specifier.type === 'ImportSpecifier' || specifier.type === 'ImportDefaultSpecifier' || specifier.type === 'ImportNamespaceSpecifier') {
        importBindings.push({
          declaration: node,
          localName: specifier.local.name,
        });
      }
    }
  }

  return importBindings;
}

function getNeededImportDeclarations(code: string, importBindings: ImportBinding[], referencedIdentifiers: Set<string>): string[] {
  const importDeclarations = new Map<number, AstNode>();

  for (const importBinding of importBindings) {
    if (referencedIdentifiers.has(importBinding.localName)) {
      importDeclarations.set(importBinding.declaration.start, importBinding.declaration);
    }
  }

  return Array.from(importDeclarations.values())
    .sort((a, b) => a.start - b.start)
    .map((node) => code.slice(node.start, node.end));
}

function removeToJsonSchemaImportIfUnused(
  code: string,
  program: AstNode,
  locals: Set<string>,
  magicString: MagicString
): void {
  for (const node of program.body ?? []) {
    if (node.type !== 'ImportDeclaration' || node.source?.value !== toJsonSchemaPackageName) {
      continue;
    }

    const removableSpecifiers = node.specifiers?.filter((specifier: AstNode) =>
      specifier.type === 'ImportSpecifier' && locals.has(specifier.local?.name)
    );

    if (removableSpecifiers.length === node.specifiers.length) {
      const end = code[node.end] === '\n' ? node.end + 1 : node.end;
      magicString.remove(node.start, end);
    }
  }
}

function walk(node: AstNode, visit: (node: AstNode, parent?: AstNode) => void, parent?: AstNode): void {
  visit(node, parent);

  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'start' || key === 'end') {
      continue;
    }

    const value = node[key];

    if (Array.isArray(value)) {
      for (const item of value) {
        if (item?.type) {
          walk(item, visit, node);
        }
      }
      continue;
    }

    if (value?.type) {
      walk(value, visit, node);
    }
  }
}

function walkWithAncestors(node: AstNode, visit: (node: AstNode, ancestors: AstNode[]) => void, ancestors: AstNode[] = []): void {
  visit(node, ancestors);

  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'start' || key === 'end') {
      continue;
    }

    const value = node[key];

    if (Array.isArray(value)) {
      for (const item of value) {
        if (item?.type) {
          walkWithAncestors(item, visit, ancestors.concat(node));
        }
      }
      continue;
    }

    if (value?.type) {
      walkWithAncestors(value, visit, ancestors.concat(node));
    }
  }
}
