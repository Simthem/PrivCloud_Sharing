import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parse } from "@formatjs/icu-messageformat-parser";
import ts from "typescript";

const frontendDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const sourceDirectory = path.join(frontendDirectory, "src");
const translationsDirectory = path.join(sourceDirectory, "i18n/translations");

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(target)));
    else if (/\.(?:ts|tsx)$/.test(entry.name)) files.push(target);
  }
  return files;
}

function literalValue(node) {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
    ? node.text
    : null;
}

function collectExpressionMessages(
  node,
  initializers,
  messages,
  visited = new Set(),
) {
  if (!node) return;
  const literal = literalValue(node);
  if (literal !== null) {
    if (literal.includes(".")) messages.add(literal);
    return;
  }
  if (ts.isParenthesizedExpression(node)) {
    collectExpressionMessages(node.expression, initializers, messages, visited);
    return;
  }
  if (ts.isConditionalExpression(node)) {
    collectExpressionMessages(node.whenTrue, initializers, messages, visited);
    collectExpressionMessages(node.whenFalse, initializers, messages, visited);
    return;
  }
  if (ts.isIdentifier(node) && initializers.has(node.text)) {
    if (visited.has(node.text)) return;
    const nextVisited = new Set(visited).add(node.text);
    collectExpressionMessages(
      initializers.get(node.text),
      initializers,
      messages,
      nextVisited,
    );
    return;
  }
  if (
    ts.isElementAccessExpression(node) ||
    ts.isPropertyAccessExpression(node)
  ) {
    collectExpressionMessages(node.expression, initializers, messages, visited);
    return;
  }
  if (ts.isObjectLiteralExpression(node)) {
    for (const property of node.properties) {
      if (ts.isPropertyAssignment(property)) {
        collectExpressionMessages(
          property.initializer,
          initializers,
          messages,
          visited,
        );
      }
    }
    return;
  }
  if (ts.isArrayLiteralExpression(node)) {
    for (const element of node.elements) {
      collectExpressionMessages(element, initializers, messages, visited);
    }
  }
}

async function collectReferencedMessages() {
  const files = (await walk(sourceDirectory)).filter(
    (file) => !file.startsWith(translationsDirectory + path.sep),
  );
  const messages = new Set();

  for (const file of files) {
    const source = await readFile(file, "utf8");
    const sourceFile = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const translators = new Set();
    const intlObjects = new Set();
    const initializers = new Map();

    const indexDeclarations = (node) => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer
      ) {
        initializers.set(node.name.text, node.initializer);
        if (ts.isCallExpression(node.initializer)) {
          const callee = node.initializer.expression;
          if (
            ts.isIdentifier(callee) &&
            ["useTranslate", "translateOutsideContext"].includes(callee.text)
          ) {
            translators.add(node.name.text);
          }
          if (ts.isIdentifier(callee) && callee.text === "useIntl") {
            intlObjects.add(node.name.text);
          }
        }
      }
      ts.forEachChild(node, indexDeclarations);
    };
    indexDeclarations(sourceFile);

    const visit = (node) => {
      if (
        (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
        node.tagName.getText(sourceFile) === "FormattedMessage"
      ) {
        const idAttribute = node.attributes.properties.find(
          (attribute) =>
            ts.isJsxAttribute(attribute) &&
            attribute.name.getText(sourceFile) === "id",
        );
        if (idAttribute?.initializer) {
          if (ts.isStringLiteral(idAttribute.initializer)) {
            collectExpressionMessages(
              idAttribute.initializer,
              initializers,
              messages,
            );
          } else if (ts.isJsxExpression(idAttribute.initializer)) {
            collectExpressionMessages(
              idAttribute.initializer.expression,
              initializers,
              messages,
            );
          }
        }
      }

      if (ts.isCallExpression(node)) {
        if (
          ts.isIdentifier(node.expression) &&
          translators.has(node.expression.text)
        ) {
          collectExpressionMessages(node.arguments[0], initializers, messages);
        }

        if (
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === "formatMessage" &&
          ts.isIdentifier(node.expression.expression) &&
          intlObjects.has(node.expression.expression.text) &&
          ts.isObjectLiteralExpression(node.arguments[0])
        ) {
          const idProperty = node.arguments[0].properties.find(
            (property) =>
              ts.isPropertyAssignment(property) &&
              property.name.getText(sourceFile) === "id",
          );
          if (idProperty && ts.isPropertyAssignment(idProperty)) {
            collectExpressionMessages(
              idProperty.initializer,
              initializers,
              messages,
            );
          }
        }

        if (node.expression.kind === ts.SyntaxKind.SuperKeyword) {
          const errorMessage = literalValue(node.arguments[0]);
          if (/^(?:bridge|webdav)\./.test(errorMessage ?? "")) {
            messages.add(errorMessage);
          }
        }
      }

      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  return messages;
}

function collectIcuSignature(message) {
  const argumentsFound = new Set();
  const tagsFound = new Set();

  const visit = (elements) => {
    for (const element of elements) {
      if (element.type >= 1 && element.type <= 6) {
        argumentsFound.add(element.value);
      }
      if (element.type === 8) {
        tagsFound.add(element.value);
        visit(element.children);
      }
      if (element.options) {
        for (const option of Object.values(element.options)) {
          visit(option.value);
        }
      }
    }
  };

  const parsed = parse(message, { ignoreTag: false });
  visit(parsed);
  return {
    arguments: [...argumentsFound].sort(),
    tags: [...tagsFound].sort(),
  };
}

async function loadCatalog(file) {
  return (
    await import(`${pathToFileURL(file).href}?catalog-audit=${Date.now()}`)
  ).default;
}

test("every statically referenced frontend message has an English definition", async () => {
  const english = await loadCatalog(
    path.join(translationsDirectory, "en-US.ts"),
  );
  const referenced = await collectReferencedMessages();
  const missing = [...referenced]
    .filter((message) => !(message in english))
    .sort();
  assert.deepEqual(missing, []);
});

test("all locale overrides are valid subsets with compatible ICU values", async () => {
  const localeFiles = (await readdir(translationsDirectory))
    .filter((file) => file.endsWith(".ts"))
    .sort();
  const catalogs = Object.fromEntries(
    await Promise.all(
      localeFiles.map(async (file) => [
        file,
        await loadCatalog(path.join(translationsDirectory, file)),
      ]),
    ),
  );
  const english = catalogs["en-US.ts"];
  const englishKeys = Object.keys(english).sort();

  assert.deepEqual(Object.keys(catalogs["fr-FR.ts"]).sort(), englishKeys);

  for (const file of localeFiles) {
    const source = await readFile(
      path.join(translationsDirectory, file),
      "utf8",
    );
    const declaredKeys = [...source.matchAll(/^\s*"([^"]+)"\s*:/gm)].map(
      (match) => match[1],
    );
    assert.equal(
      new Set(declaredKeys).size,
      declaredKeys.length,
      `${file} contains a duplicate message key`,
    );

    for (const [key, message] of Object.entries(catalogs[file])) {
      assert.ok(key in english, `${file} defines unknown message ${key}`);
      assert.deepEqual(
        collectIcuSignature(message),
        collectIcuSignature(english[key]),
        `${file} has incompatible ICU values for ${key}`,
      );
    }
  }
});
