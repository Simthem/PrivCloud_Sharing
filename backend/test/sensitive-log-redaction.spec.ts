import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import * as ts from "typescript";

const read = (relativePath: string) =>
  readFileSync(path.resolve(relativePath), "utf8");

const listTypeScriptFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return listTypeScriptFiles(entryPath);
    if (!entry.name.endsWith(".ts") || entry.name.endsWith(".spec.ts")) {
      return [];
    }
    return [entryPath];
  });

const runtimeLoggerCalls = listTypeScriptFiles(path.resolve("src")).flatMap(
  (filePath) => {
    const sourceText = readFileSync(filePath, "utf8");
    const sourceFile = ts.createSourceFile(
      filePath,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
    );
    const calls: string[] = [];
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isPropertyAccessExpression(node.expression.expression) &&
        node.expression.expression.name.text === "logger"
      ) {
        calls.push(node.getText(sourceFile));
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return calls;
  },
);

const authSource = read("src/auth/auth.service.ts");
const ldapSource = read("src/auth/ldap.service.ts");
const oauthFilterSource = read("src/oauth/filter/oauthException.filter.ts");
const cacheSource = read("src/cache/cache.module.ts");
const shareSources = [
  "src/share/share.service.ts",
  "src/file/file.service.ts",
  "src/file/local.service.ts",
  "src/file/s3.service.ts",
]
  .map(read)
  .join("\n");

assert.doesNotMatch(authSource, /logger\.[a-z]+\([^;]*(?:dto\.(?:email|username)|\.message)/s);
assert.doesNotMatch(ldapSource, /inspect\(|logger\.[a-z]+\([^;]*\$\{username\}/s);
assert.doesNotMatch(oauthFilterSource, /JSON\.stringify\([^)]*request\.query/);
assert.doesNotMatch(cacheSource, /logger\.[a-z]+\([^;]*redisUrl/s);
assert.doesNotMatch(shareSources, /logger\.[a-z]+\([^;]*shareId/s);
assert.deepEqual(
  runtimeLoggerCalls.filter((call) =>
    /\.email\b|\$\{email\}|recipientEmail|sessionId\b|\.endpoint\b|fileName\b|shareId\b|share\.id\b|\.message\b|\.stack\b|inspect\(|logger\.(?:error|warn|log|debug)\(\s*(?:error|err|e)\s*\)/.test(
      call,
    ),
  ),
  [],
);

console.log("ok - authentication and integration logs redact sensitive values");
