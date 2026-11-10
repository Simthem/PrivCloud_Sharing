import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { Prisma } from "@prisma/client";
import ts from "typescript";
import { SECRET_FIELDS, TOKEN_FIELDS } from "src/config/account-secrets";
import { SEALED_COLUMNS } from "src/prisma/sealed-columns";
import { createUnitTestRunner } from "./unit-test";

const { testCase, run } = createUnitTestRunner("Sealed column usage");

const PRISMA_OPERATIONS = new Set([
  "aggregate",
  "count",
  "delete",
  "deleteMany",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "findUnique",
  "findUniqueOrThrow",
  "groupBy",
  "update",
  "updateMany",
  "upsert",
]);
const EQUALITY = new Set(["equals", "in", "not", "notIn"]);
const PARTIAL = new Set(["contains", "startsWith", "endsWith", "search"]);
const RELATION_FILTERS = new Set(["some", "every", "none", "is", "isNot"]);

const delegates = new Map(
  Prisma.dmmf.datamodel.models.map((model) => [
    model.name[0].toLowerCase() + model.name.slice(1),
    model.name,
  ]),
);
const relations = new Map(
  Prisma.dmmf.datamodel.models.map((model) => [
    model.name,
    new Map(
      model.fields
        .filter((field) => field.kind === "object")
        .map((field) => [field.name, field.type]),
    ),
  ]),
);
const STORED_ELSEWHERE: Record<string, Record<string, string>> = {};
for (const fields of [TOKEN_FIELDS, SECRET_FIELDS]) {
  for (const [model, columns] of Object.entries(fields)) {
    for (const column of Object.keys(columns)) {
      (STORED_ELSEWHERE[model] ??= {})[column] = column;
    }
  }
}
const secretOwner = (model: string, column: string) =>
  SECRET_FIELDS[model]?.[column];
const sealedNames = new Set(
  Object.values(SEALED_COLUMNS).flatMap((columns) => Object.keys(columns)),
);

const keyOf = (property: ts.ObjectLiteralElementLike) =>
  ts.isPropertyAssignment(property) &&
  (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
    ? property.name.text
    : null;

const entries = (node: ts.Node) =>
  ts.isObjectLiteralExpression(node)
    ? node.properties.flatMap((property) => {
        const key = keyOf(property);
        return key && ts.isPropertyAssignment(property)
          ? [[key, property.initializer] as const]
          : [];
      })
    : [];

const columnNames = (node: ts.Node): string[] => {
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.flatMap((element) => columnNames(element));
  }
  if (ts.isStringLiteral(node)) return [node.text];
  return entries(node).map(([key]) => key);
};

/** Queries that bypass the encryption layer or that it cannot translate. */
function findSealedColumnMisuse(fileName: string, source: string) {
  const file = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const problems: string[] = [];
  const report = (node: ts.Node, message: string) => {
    const line = file.getLineAndCharacterOfPosition(node.getStart()).line + 1;
    problems.push(`${fileName}:${line} ${message}`);
  };
  const kind = (model: string, column: string) =>
    SEALED_COLUMNS[model]?.[column];

  const checkWhere = (model: string, node: ts.Node) => {
    if (ts.isArrayLiteralExpression(node)) {
      node.elements.forEach((element) => checkWhere(model, element));
      return;
    }
    for (const [key, value] of entries(node)) {
      if (key === "AND" || key === "OR" || key === "NOT") {
        checkWhere(model, value);
        continue;
      }
      const related = relations.get(model)?.get(key);
      if (related) {
        const quantified = entries(value).some(([name]) =>
          RELATION_FILTERS.has(name),
        );
        if (quantified) {
          entries(value).forEach(([, inner]) => checkWhere(related, inner));
        } else {
          checkWhere(related, value);
        }
        continue;
      }
      if (secretOwner(model, key)) {
        const nullCheck =
          value.kind === ts.SyntaxKind.NullKeyword ||
          (ts.isObjectLiteralExpression(value) &&
            entries(value).every(
              ([name, inner]) =>
                name === "not" && inner.kind === ts.SyntaxKind.NullKeyword,
            ));
        if (!nullCheck) report(value, `${model}.${key} is sealed per owner`);
        continue;
      }
      if (!kind(model, key) || !ts.isObjectLiteralExpression(value)) continue;
      const operators = entries(value).map(([name]) => name);
      const insensitiveEmail =
        model === "User" &&
        key === "email" &&
        operators.includes("equals") &&
        operators.every((name) => name === "equals" || name === "mode");
      if (insensitiveEmail) continue;
      const unsupported = operators.filter((name) => !EQUALITY.has(name));
      if (unsupported.length) {
        report(
          value,
          `${model}.${key} filtered with ${unsupported.join(", ")}`,
        );
      }
    }
  };

  const checkArgs = (model: string, node: ts.Node) => {
    for (const [key, value] of entries(node)) {
      if (key === "where" || key === "having") checkWhere(model, value);
      if (key === "orderBy") {
        for (const element of ts.isArrayLiteralExpression(value)
          ? value.elements
          : [value]) {
          for (const column of columnNames(element)) {
            if (kind(model, column) || STORED_ELSEWHERE[model]?.[column]) {
              report(element, `${model}.${column} used to order rows`);
            }
          }
        }
      }
      if (key === "distinct" || key === "by") {
        for (const column of columnNames(value)) {
          if (
            kind(model, column) === "text" ||
            STORED_ELSEWHERE[model]?.[column]
          ) {
            report(value, `${model}.${column} used to group rows`);
          }
        }
      }
      if (key === "data" || key === "create" || key === "update") {
        checkData(model, value);
      }
      if (key === "select") checkSelect(model, value);
      if (key === "select" || key === "include") {
        for (const [field, inner] of entries(value)) {
          const related = relations.get(model)?.get(field);
          if (related) checkArgs(related, inner);
        }
      }
    }
  };

  const sealsSecret = (value: ts.Node) =>
    value.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isIdentifier(value) && value.text === "undefined") ||
    (ts.isCallExpression(value) &&
      /^(this\.)?(seal|stored)\w*$/.test(value.expression.getText()));

  const checkData = (model: string, node: ts.Node) => {
    if (ts.isArrayLiteralExpression(node)) {
      node.elements.forEach((element) => checkData(model, element));
      return;
    }
    for (const [key, value] of entries(node)) {
      if (secretOwner(model, key)) {
        const written = ts.isObjectLiteralExpression(value)
          ? (entries(value).find(([name]) => name === "set")?.[1] ?? value)
          : value;
        if (!sealsSecret(written)) {
          report(value, `${model}.${key} written without sealAccountSecret`);
        }
        continue;
      }
      const related = relations.get(model)?.get(key);
      if (!related) continue;
      for (const [operation, inner] of entries(value)) {
        if (operation === "createMany") {
          entries(inner)
            .filter(([name]) => name === "data")
            .forEach(([, data]) => checkData(related, data));
        } else if (
          operation === "create" ||
          operation === "update" ||
          operation === "upsert" ||
          operation === "connectOrCreate" ||
          operation === "updateMany"
        ) {
          const nested = ts.isArrayLiteralExpression(inner)
            ? inner.elements
            : [inner];
          for (const element of nested) {
            const parts = entries(element);
            const wrapped = parts.filter(([name]) =>
              ["data", "create", "update"].includes(name),
            );
            if (wrapped.length) {
              wrapped.forEach(([, data]) => checkData(related, data));
            } else {
              checkData(related, element);
            }
          }
        }
      }
    }
  };

  const checkSelect = (model: string, node: ts.Node) => {
    const selected = new Set(
      entries(node)
        .filter(([, value]) => value.kind !== ts.SyntaxKind.FalseKeyword)
        .map(([name]) => name),
    );
    for (const field of selected) {
      const owner = secretOwner(model, field);
      if (owner && !selected.has(owner)) {
        report(node, `${model}.${field} selected without ${owner}`);
      }
    }
  };

  const rawSql = (node: ts.Node) => {
    const callee = ts.isTaggedTemplateExpression(node)
      ? node.tag
      : ts.isCallExpression(node)
        ? node.expression
        : null;
    if (!callee || !ts.isPropertyAccessExpression(callee)) return false;
    return (
      /^\$(query|execute)Raw(Unsafe)?$/.test(callee.name.text) ||
      (callee.expression.getText() === "Prisma" && callee.name.text === "sql")
    );
  };

  const visit = (node: ts.Node) => {
    if (rawSql(node)) {
      const text = node.getText();
      for (const fields of [SEALED_COLUMNS, STORED_ELSEWHERE]) {
        for (const [model, columns] of Object.entries(fields)) {
          for (const column of Object.keys(columns)) {
            if (text.includes(`"${model}"`) && text.includes(`"${column}"`)) {
              report(node, `raw SQL reads ${model}.${column}`);
            }
          }
        }
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      PRISMA_OPERATIONS.has(node.expression.name.text) &&
      ts.isPropertyAccessExpression(node.expression.expression)
    ) {
      const model = delegates.get(node.expression.expression.name.text);
      const args = node.arguments[0];
      if (model && args) checkArgs(model, args);
    }
    if (
      ts.isPropertyAssignment(node) &&
      sealedNames.has(keyOf(node) ?? "") &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      const partial = entries(node.initializer)
        .map(([name]) => name)
        .filter((name) => PARTIAL.has(name));
      if (partial.length) {
        report(node, `${keyOf(node)} searched with ${partial.join(", ")}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return [...new Set(problems)];
}

const sourceFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".spec.ts")
      ? [path]
      : [];
  });

testCase("every misuse of an encrypted column is caught", () => {
  const sample = `
    this.prisma.$queryRaw\`SELECT "id" FROM "User" WHERE lower("email") = \${a}\`;
    this.prisma.share.findUnique({
      where: { id },
      include: { files: { orderBy: { name: "asc" } } },
    });
    tx.teamFolder.findMany({ where: { team: { name: { startsWith: q } } } });
    this.prisma.teamInvitation.findFirst({
      where: { email: { equals: e, mode: "insensitive" } },
    });
    this.prisma.share.groupBy({ by: ["description"], _count: true });
    const where = { senderEmail: { contains: q } };
    this.prisma.oAuthUser.findFirst({ where: { verifiedEmail: email } });
    this.prisma.user.update({ where: { id }, data: { totpSecret: secret } });
    this.prisma.user.findUnique({ where: { id }, select: { totpSecret: true } });
    this.prisma.reverseShare.findMany({ orderBy: { token: "asc" } });
  `;
  assert.deepEqual(findSealedColumnMisuse("sample.ts", sample), [
    "sample.ts:2 raw SQL reads User.email",
    "sample.ts:5 File.name used to order rows",
    "sample.ts:7 Team.name filtered with startsWith",
    "sample.ts:7 name searched with startsWith",
    "sample.ts:9 TeamInvitation.email filtered with mode",
    "sample.ts:11 Share.description used to group rows",
    "sample.ts:12 senderEmail searched with contains",
    "sample.ts:13 OAuthUser.verifiedEmail is sealed per owner",
    "sample.ts:14 User.totpSecret written without sealAccountSecret",
    "sample.ts:15 User.totpSecret selected without id",
    "sample.ts:16 ReverseShare.token used to order rows",
  ]);
});

testCase("supported queries on encrypted columns pass", () => {
  const sample = `
    this.prisma.user.findFirst({
      where: { email: { equals: e, mode: "insensitive" } },
    });
    this.prisma.user.findMany({ where: { OR: [{ email: a }, { email: { in: b } }] } });
    this.prisma.file.findMany({ where: { shareId }, orderBy: { createdAt: "asc" } });
    this.prisma.teamAccessLog.groupBy({ by: ["actorEmail"], _count: { id: true } });
    this.prisma.$queryRaw\`SELECT count(*) FROM "File" WHERE "shareId" = \${id}\`;
    this.prisma.signatureRecipient.findFirst({ where: { signingToken: stored } });
    this.prisma.user.update({
      where: { id },
      data: { totpSecret: sealAccountSecret(id, "totpSecret", secret) },
    });
    this.prisma.oAuthUser.findMany({
      where: { verifiedEmail: { not: null } },
      select: { userId: true, verifiedEmail: true },
    });
  `;
  assert.deepEqual(findSealedColumnMisuse("sample.ts", sample), []);
});

testCase("the backend never misuses an encrypted column", () => {
  const root = join(__dirname, "..");
  const problems = sourceFiles(join(root, "src"))
    .filter((path) => !path.endsWith("sealed-columns.ts"))
    .flatMap((path) =>
      findSealedColumnMisuse(relative(root, path), readFileSync(path, "utf8")),
    );
  assert.deepEqual(problems, []);
});

void run();
