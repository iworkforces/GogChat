/**
 * Feature spec parser.
 *
 * Uses the installed TypeScript 6.x compiler API (`createSourceFile`) to read
 * declarative metadata from initializer specs. Typecheck itself uses
 * `@typescript/native` (TS 7), which is not this parser.
 *
 * Fail-closed: every exported array element must be an object literal with
 * static identifier or string keys. Spreads, calls, identifiers, conditionals,
 * holes, computed names, and malformed known metadata are rejected. `init` and
 * `cleanup` are treated as operational and are not inspected or evaluated.
 */

import ts from 'typescript';

const FEATURE_PHASES = ['security', 'critical', 'ui', 'deferred'];
const OPERATIONAL_KEYS = new Set(['init', 'cleanup']);
const KNOWN_METADATA = new Set([
  'name',
  'phase',
  'description',
  'required',
  'dependencies',
  'requires',
  'platforms',
]);
const PLATFORMS = ['darwin', 'win32', 'unsupported'];

export function parseSpecSource(source, fileName = 'spec.ts') {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );

  const exportedArray = findExportedArray(sourceFile);
  if (!exportedArray) {
    throw new Error(`[featurePlanPlugin] No 'export const NAME = [ ... ]' array in ${fileName}`);
  }

  const entries = exportedArray.array.elements.map((element, index) =>
    extractFeatureEntry(requireObjectLiteral(element, fileName, index), fileName, index)
  );

  return { exportName: exportedArray.exportName, entries };
}

function findExportedArray(sourceFile) {
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement) || !hasExportModifier(statement)) continue;

    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      const initializer = unwrapExpression(declaration.initializer);
      if (ts.isArrayLiteralExpression(initializer)) {
        return { exportName: declaration.name.text, array: initializer };
      }
    }
  }
  return undefined;
}

function hasExportModifier(statement) {
  const modifiers = ts.canHaveModifiers(statement)
    ? ts.getModifiers(statement)
    : statement.modifiers;
  return Boolean(modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword));
}

function unwrapExpression(node) {
  let current = node;
  while (current) {
    if (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isNonNullExpression(current) ||
      (typeof ts.isTypeAssertionExpression === 'function' && ts.isTypeAssertionExpression(current))
    ) {
      current = current.expression;
      continue;
    }
    break;
  }
  return current;
}

function requireObjectLiteral(rawElement, fileName, index) {
  if (!rawElement || rawElement.kind === ts.SyntaxKind.OmittedExpression) {
    throw specError(
      fileName,
      index,
      undefined,
      'array element must be an object literal (hole is not allowed)'
    );
  }

  const element = unwrapExpression(rawElement);
  if (ts.isObjectLiteralExpression(element)) return element;

  throw specError(
    fileName,
    index,
    undefined,
    `array element must be an object literal (${classifyNonObject(element)} is not allowed)`
  );
}

function classifyNonObject(node) {
  if (ts.isSpreadElement(node)) return 'spread';
  if (ts.isCallExpression(node) || ts.isNewExpression(node)) return 'call';
  if (ts.isIdentifier(node)) return 'identifier';
  if (ts.isConditionalExpression(node)) return 'conditional';
  return 'unsupported expression';
}

function extractFeatureEntry(objectLiteral, fileName, index) {
  const result = {};

  for (const property of objectLiteral.properties) {
    if (ts.isSpreadAssignment(property)) {
      throw specError(fileName, index, undefined, 'spread properties are not allowed');
    }

    if (ts.isShorthandPropertyAssignment(property)) {
      const key = staticPropertyName(property.name, fileName, index);
      if (OPERATIONAL_KEYS.has(key)) continue;
      if (KNOWN_METADATA.has(key)) {
        throw specError(fileName, index, key, 'expected a literal value');
      }
      continue;
    }

    if (ts.isMethodDeclaration(property)) {
      const key = staticPropertyName(property.name, fileName, index);
      if (OPERATIONAL_KEYS.has(key)) continue;
      if (KNOWN_METADATA.has(key)) {
        throw specError(fileName, index, key, 'expected a literal value');
      }
      continue;
    }

    if (!ts.isPropertyAssignment(property)) {
      throw specError(fileName, index, undefined, 'unsupported object member');
    }

    const key = staticPropertyName(property.name, fileName, index);
    if (OPERATIONAL_KEYS.has(key)) continue;

    switch (key) {
      case 'name':
      case 'description':
        result[key] = requireStringLiteral(property.initializer, fileName, index, key);
        break;
      case 'phase': {
        const phase = requireStringLiteral(property.initializer, fileName, index, 'phase');
        if (!FEATURE_PHASES.includes(phase)) {
          throw specError(fileName, index, 'phase', `expected one of ${FEATURE_PHASES.join('|')}`);
        }
        result.phase = phase;
        break;
      }
      case 'required':
        result.required = requireBooleanLiteral(property.initializer, fileName, index, 'required');
        break;
      case 'dependencies':
      case 'requires':
        result[key] = requireStringArray(property.initializer, fileName, index, key);
        break;
      case 'platforms':
        result.platforms = requirePlatformArray(property.initializer, fileName, index);
        break;
      default:
        break;
    }
  }

  if (result.name === undefined) {
    throw specError(fileName, index, 'name', 'missing required string literal');
  }
  if (result.phase === undefined) {
    throw specError(fileName, index, 'phase', 'missing required string literal');
  }

  return result;
}

function staticPropertyName(name, fileName, index) {
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name)) {
    const expression = unwrapExpression(name.expression);
    const hint =
      ts.isStringLiteral(expression) ||
      ts.isNoSubstitutionTemplateLiteral(expression) ||
      ts.isIdentifier(expression)
        ? expression.text
        : '[computed]';
    throw specError(fileName, index, hint, 'computed property names are not allowed');
  }
  throw specError(
    fileName,
    index,
    undefined,
    'property name must be a static identifier or string'
  );
}

function requireStringLiteral(node, fileName, index, property) {
  const value = unwrapExpression(node);
  if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) {
    return value.text;
  }
  throw specError(fileName, index, property, 'expected a string literal');
}

function requireBooleanLiteral(node, fileName, index, property) {
  const value = unwrapExpression(node);
  if (value.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (value.kind === ts.SyntaxKind.FalseKeyword) return false;
  throw specError(fileName, index, property, 'expected true or false');
}

function requireStringArray(node, fileName, index, property) {
  const value = unwrapExpression(node);
  if (!ts.isArrayLiteralExpression(value)) {
    throw specError(fileName, index, property, 'expected an array of string literals');
  }

  const items = [];
  for (const raw of value.elements) {
    if (!raw || raw.kind === ts.SyntaxKind.OmittedExpression || ts.isSpreadElement(raw)) {
      throw specError(fileName, index, property, 'expected an array of string literals');
    }
    const element = unwrapExpression(raw);
    if (!ts.isStringLiteral(element) && !ts.isNoSubstitutionTemplateLiteral(element)) {
      throw specError(fileName, index, property, 'expected an array of string literals');
    }
    items.push(element.text);
  }
  return items;
}

function requirePlatformArray(node, fileName, index) {
  const value = unwrapExpression(node);
  if (!ts.isArrayLiteralExpression(value)) {
    throw specError(fileName, index, 'platforms', 'expected an array of platform names');
  }
  return value.elements.map((raw) => {
    const element = unwrapExpression(raw);
    let name;
    if (ts.isStringLiteral(element) || ts.isNoSubstitutionTemplateLiteral(element)) {
      name = element.text;
    } else if (
      ts.isPropertyAccessExpression(element) &&
      ts.isIdentifier(element.expression) &&
      element.expression.text === 'SUPPORTED_PLATFORM_NAMES'
    ) {
      name = { macOS: 'darwin', windows: 'win32' }[element.name.text];
    }
    if (!PLATFORMS.includes(name)) {
      throw specError(fileName, index, 'platforms', 'expected a supported static platform name');
    }
    return name;
  });
}

function specError(fileName, index, property, message) {
  const location =
    property === undefined || property === null
      ? `${fileName}[${index}]`
      : `${fileName}[${index}].${property}`;
  return new Error(`[featurePlanPlugin] ${location}: ${message}`);
}
