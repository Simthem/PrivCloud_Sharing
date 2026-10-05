import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const requireBackend = createRequire(join(root, "backend/package.json"));
const Database = requireBackend("better-sqlite3");
const diagnostic = readFileSync(
  join(root, "scripts/diagnose-upload-state.cjs"),
  "utf8",
);

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "privcloud-upload-diagnostic-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, "dist"));
  symlinkSync(
    join(root, "backend/node_modules"),
    join(directory, "node_modules"),
    "dir",
  );
  const dbPath = join(directory, "fixture.db");
  writeFileSync(
    join(directory, "dist/constants.js"),
    "exports.DATABASE_URL = process.env.DATABASE_URL; exports.resolveDbUrl = url => url.slice(5);\n",
  );
  const tracePath = join(directory, "prepared-sql.jsonl");
  const preloadPath = join(directory, "trace-prepare.cjs");
  writeFileSync(
    preloadPath,
    `const fs = require('node:fs');
const Database = require('better-sqlite3');
const original = Database.prototype.prepare;
Database.prototype.prepare = function(sql) {
  fs.appendFileSync(${JSON.stringify(tracePath)}, JSON.stringify(sql) + '\\n');
  return original.call(this, sql);
};\n`,
  );
  const database = new Database(dbPath);
  database.exec(`CREATE TABLE Share (
    id TEXT PRIMARY KEY, adminAuditId TEXT, uploadLocked INTEGER,
    storageProvider TEXT, createdAt TEXT, expiration TEXT, title TEXT);
    CREATE TABLE File (
    id TEXT PRIMARY KEY, shareId TEXT, size TEXT, filename TEXT,
    metadataScheme TEXT, encryptedMetadata TEXT);
    INSERT INTO Share VALUES ('private-share-a', '12345678-aaaa-4000-8000-000000000001', 0, 'S3', '2026-10-03', '2026-10-04', 'PRIVATE_TITLE');
    INSERT INTO Share VALUES ('private-share-b', '12345678-bbbb-4000-8000-000000000002', 1, 'LOCAL', '2026-10-02', '2026-10-04', 'PRIVATE_TITLE');
    INSERT INTO File VALUES ('file-a', 'private-share-a', 361019527987, 'PRIVATE_FILENAME', 'FILE_META_V1', 'PRIVATE_CIPHERTEXT');`);
  database.close();
  const hash = () =>
    createHash("sha256").update(readFileSync(dbPath)).digest("hex");
  const before = hash();
  return (reference) => {
    writeFileSync(tracePath, "");
    const result = spawnSync(
      process.execPath,
      ["--require", preloadPath, "-", reference],
      {
        input: diagnostic,
        cwd: directory,
        env: {
          ...process.env,
          NODE_OPTIONS: "",
          DATABASE_URL: `file:${dbPath}`,
        },
        encoding: "utf8",
        timeout: 15000,
      },
    );
    assert.equal(result.error, undefined);
    result.preparedSql = readFileSync(tracePath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.equal(hash(), before, "read-only diagnosis changed the database");
    for (const secret of [
      "private-share-a",
      "private-share-b",
      "PRIVATE_TITLE",
      "PRIVATE_FILENAME",
      "PRIVATE_CIPHERTEXT",
    ]) {
      assert.ok(!result.stdout.includes(secret), `report exposed ${secret}`);
      assert.ok(!result.stderr.includes(secret), `error exposed ${secret}`);
    }
    return result;
  };
}

test("unique audit prefix reports exact bytes without names or database writes", (t) => {
  const result = fixture(t)("12345678-aaaa");
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, "FOUND");
  assert.equal(report.shares[0].registered_bytes, "361019527987");
  assert.equal(report.shares[0].registered_go, "361.02");
  assert.equal(report.shares[0].registered_gio, "336.23");
  assert.equal(report.shares[0].finalized, false);
  assert.equal(report.shares[0].last_upload_activity, null);
  assert.equal(report.files[0].has_encrypted_metadata, true);
  assert.equal(report.file_list_truncated, false);
});

test("ambiguous and absent references cannot expose a chosen share's file list", (t) => {
  const run = fixture(t);
  const ambiguous = run("12345678");
  assert.equal(ambiguous.status, 3);
  const report = JSON.parse(ambiguous.stdout);
  assert.equal(report.status, "AMBIGUOUS_PREFIX");
  assert.equal(report.shares.length, 2);
  assert.equal(report.files, undefined);
  const absent = run("87654321");
  assert.equal(absent.status, 3);
  assert.equal(JSON.parse(absent.stdout).status, "NOT_FOUND");
});

test("list mode exposes only recent opaque summaries", (t) => {
  const result = fixture(t)("--list");
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, "RECENT_SHARES");
  assert.equal(report.shares.length, 2);
  assert.equal(report.files, undefined);
});

test("placeholder and SQL-like references fail before opening a database", (t) => {
  const run = fixture(t);
  for (const value of ["FULL_REFERENCE", "12345678' OR 1=1", "1234"]) {
    const result = run(value);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.deepEqual(result.preparedSql, []);
    assert.ok(result.stderr.includes("full audit reference"));
  }
});

test("prefix lengths and case cannot change prepared SQLite SQL text", (t) => {
  const run = fixture(t);
  const prefix = run("12345678-aaaa");
  const full = run("12345678-AAAA-4000-8000-000000000001");
  assert.equal(prefix.status, 0, prefix.stderr);
  assert.equal(full.status, 0, full.stderr);
  assert.deepEqual(JSON.parse(prefix.stdout), JSON.parse(full.stdout));
  assert.deepEqual(prefix.preparedSql, full.preparedSql);
  assert.ok(prefix.preparedSql.some((sql) => sql.includes('s."adminAuditId"')));
});

function postgresFixture(t) {
  const directory = mkdtempSync(
    join(tmpdir(), "privcloud-upload-pg-diagnostic-"),
  );
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, "node_modules/pg"), { recursive: true });
  writeFileSync(
    join(directory, "node_modules/pg/index.js"),
    `
const fs = require('node:fs');
class Client {
  async connect() {}
  async end() {}
  async query(sql, params = []) {
    fs.appendFileSync('queries.jsonl', JSON.stringify({sql, params}) + '\\n');
    if (sql.includes('information_schema.columns')) {
      return {rows: ['id', 'adminAuditId', 'uploadLocked', 'storageProvider'].map(column_name => ({table_name: 'Share', column_name}))
        .concat(['id', 'shareId', 'size'].map(column_name => ({table_name: 'File', column_name})))};
    }
    if (sql.includes('registered_files')) {
      return {rows: [{audit_reference:'12345678-aaaa-4000-8000-000000000001', finalized:false,
        previously_finalized:null, registered_files:'0', registered_bytes:'0'}]};
    }
    return {rows: []};
  }
}
module.exports = {Client};
`,
  );
  return (reference, schema) => {
    const tracePath = join(directory, "queries.jsonl");
    writeFileSync(tracePath, "");
    const result = spawnSync(process.execPath, ["-", reference], {
      input: diagnostic,
      cwd: directory,
      env: {
        ...process.env,
        NODE_OPTIONS: "",
        DATABASE_URL: `postgresql://test@localhost/test?schema=${schema}`,
      },
      encoding: "utf8",
      timeout: 15000,
    });
    assert.equal(result.error, undefined);
    const queries = readFileSync(tracePath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    return { ...result, queries };
  };
}

test("PostgreSQL binds prefix length, reference and schema outside SQL text", (t) => {
  const run = postgresFixture(t);
  const prefix = run("12345678-aaaa", "tenant_a");
  const full = run("12345678-AAAA-4000-8000-000000000001", "tenant_b");
  assert.equal(prefix.status, 0, prefix.stderr);
  assert.equal(full.status, 0, full.stderr);
  assert.deepEqual(
    prefix.queries.map((item) => item.sql),
    full.queries.map((item) => item.sql),
  );
  const summary = prefix.queries.find((item) =>
    item.sql.includes("registered_files"),
  );
  assert.deepEqual(summary.params, [13, "12345678-aaaa"]);
  assert.deepEqual(
    full.queries.find((item) => item.sql.includes("registered_files")).params,
    [36, "12345678-aaaa-4000-8000-000000000001"],
  );
  const searchPath = prefix.queries.find((item) =>
    item.sql.includes("set_config"),
  );
  assert.deepEqual(searchPath.params, ["tenant_a"]);
  assert.ok(
    prefix.queries.every(
      ({ sql }) => !sql.includes("tenant_a") && !sql.includes("12345678-aaaa"),
    ),
  );
  assert.equal(
    prefix.queries[0].sql,
    "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
  );
  assert.equal(prefix.queries.at(-1).sql, "ROLLBACK");
});

test("invalid PostgreSQL schema never reaches the driver", (t) => {
  const result = postgresFixture(t)(
    "12345678-aaaa",
    "public%22%3BDROP%20TABLE%20Share%3B",
  );
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes("SCHEMA_UNSUPPORTED"));
  assert.deepEqual(result.queries, []);
});
