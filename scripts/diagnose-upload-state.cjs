"use strict";

const fs = require("node:fs");
const path = require("node:path");

// Run with node from the application's backend directory, including via stdin.
const requested = process.argv[2] || "";
const list = requested === "--list";
if (!list && !/^[0-9a-f-]{8,36}$/i.test(requested)) {
  console.error(
    "Provide the full audit reference, its prefix (at least 8 characters) or --list. FULL_REFERENCE is a placeholder to replace.",
  );
  process.exit(2);
}

function byteDisplay(value, denominator) {
  const hundredths = (BigInt(value) * 100n + denominator / 2n) / denominator;
  return `${hundredths / 100n}.${String(hundredths % 100n).padStart(2, "0")}`;
}

async function main() {
  let database;
  let inTransaction = false;
  let query;
  let placeholder;
  let shareTable;
  let fileTable;
  let shareColumns;
  let fileColumns;
  let endpoint;
  let sizeSum;
  try {
    const constantsPath = ["dist/src/constants.js", "dist/constants.js"].find(
      (file) => fs.existsSync(file),
    );
    const constants = constantsPath ? require(path.resolve(constantsPath)) : {};
    const databaseUrl = constants.DATABASE_URL || process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error("DATABASE_URL_MISSING");

    if (/^postgres(?:ql)?:/.test(databaseUrl)) {
      const url = new URL(databaseUrl);
      const schema = url.searchParams.get("schema") || "public";
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(schema))
        throw new Error("SCHEMA_UNSUPPORTED");
      url.searchParams.delete("schema");
      const { Client } = require("pg");
      database = new Client({
        connectionString: url.toString(),
        connectionTimeoutMillis: 10000,
      });
      await database.connect();
      query = async (sql, params = []) =>
        (await database.query(sql, params)).rows;
      placeholder = "$1";
      shareTable = '"Share"';
      fileTable = '"File"';
      sizeSum = 'coalesce(sum(f."size"::numeric), 0)';
      endpoint = {
        engine: "PostgreSQL",
        host: url.hostname,
        port: url.port || "5432",
        schema,
      };
      await query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      inTransaction = true;
      await query("SET LOCAL statement_timeout = '10s'");
      await query(
        "SELECT set_config('search_path', 'pg_catalog, ' || quote_ident($1) || ', pg_temp', true)",
        [schema],
      );
      const columns = await query(
        "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name IN ('Share', 'File')",
        [schema],
      );
      shareColumns = new Set(
        columns
          .filter((row) => row.table_name === "Share")
          .map((row) => row.column_name),
      );
      fileColumns = new Set(
        columns
          .filter((row) => row.table_name === "File")
          .map((row) => row.column_name),
      );
    } else if (databaseUrl.startsWith("file:")) {
      if (typeof constants.resolveDbUrl !== "function")
        throw new Error("SQLITE_PATH_UNAVAILABLE");
      const Database = require("better-sqlite3");
      database = new Database(constants.resolveDbUrl(databaseUrl), {
        readonly: true,
        fileMustExist: true,
        timeout: 10000,
      });
      database.defaultSafeIntegers(true);
      database.pragma("query_only = ON");
      query = async (sql, params = []) => {
        const statement = database.prepare(sql);
        return statement.reader
          ? statement.all(...params)
          : statement.run(...params);
      };
      placeholder = "?";
      shareTable = '"Share"';
      fileTable = '"File"';
      sizeSum = 'coalesce(sum(CAST(f."size" AS INTEGER)), 0)';
      endpoint = { engine: "SQLite", applicationDatabase: true };
      database.exec("BEGIN");
      inTransaction = true;
      shareColumns = new Set(
        database.pragma("table_info(Share)").map((row) => row.name),
      );
      fileColumns = new Set(
        database.pragma("table_info(File)").map((row) => row.name),
      );
    } else {
      throw new Error("DATABASE_TYPE_UNSUPPORTED");
    }

    if (
      !["id", "adminAuditId", "uploadLocked", "storageProvider"].every(
        (column) => shareColumns.has(column),
      ) ||
      !["id", "shareId", "size"].every((column) => fileColumns.has(column))
    ) {
      throw new Error("SCHEMA_INCOMPATIBLE");
    }
    const optional = (column, alias) =>
      `${shareColumns.has(column) ? `s."${column}"` : "NULL"} AS ${alias}`;
    const where = list
      ? ""
      : placeholder === "$1"
        ? 'WHERE substr(s."adminAuditId", 1, $1) = $2'
        : 'WHERE substr(s."adminAuditId", 1, ?) = ?';
    const ordering = shareColumns.has("createdAt")
      ? 's."createdAt" DESC'
      : 's."adminAuditId"';
    const summaries = await query(
      `SELECT s."adminAuditId" AS audit_reference,
      s."uploadLocked" AS finalized,
      ${optional("hasBeenCompleted", "previously_finalized")},
      ${optional("uploadLastActivityAt", "last_upload_activity")},
      ${optional("expiration", "expiration")}, s."storageProvider" AS storage_provider,
      count(f."id") AS registered_files, ${sizeSum} AS registered_bytes
      FROM ${shareTable} s LEFT JOIN ${fileTable} f ON f."shareId" = s."id"
      ${where} GROUP BY s."id" ORDER BY ${ordering}${list ? " LIMIT 20" : ""}`,
      list ? [] : [requested.length, requested.toLowerCase()],
    );
    for (const summary of summaries) {
      summary.finalized =
        summary.finalized === true || Number(summary.finalized) === 1;
      if (summary.previously_finalized !== null) {
        summary.previously_finalized =
          summary.previously_finalized === true ||
          Number(summary.previously_finalized) === 1;
      }
      summary.registered_go = byteDisplay(
        summary.registered_bytes,
        1000000000n,
      );
      summary.registered_gio = byteDisplay(
        summary.registered_bytes,
        1073741824n,
      );
    }
    const report = {
      database: endpoint,
      status: list
        ? "RECENT_SHARES"
        : summaries.length === 0
          ? "NOT_FOUND"
          : summaries.length === 1
            ? "FOUND"
            : "AMBIGUOUS_PREFIX",
      shares: summaries,
    };
    if (!list && summaries.length === 1) {
      report.files = await query(
        `SELECT f."id" AS file_reference, f."size" AS stored_bytes,
        ${fileColumns.has("metadataScheme") ? 'f."metadataScheme"' : "NULL"} AS metadata_scheme,
        ${fileColumns.has("encryptedMetadata") ? 'f."encryptedMetadata" IS NOT NULL' : "NULL"} AS has_encrypted_metadata
        FROM ${fileTable} f JOIN ${shareTable} s ON s."id" = f."shareId"
        WHERE s."adminAuditId" = ${placeholder} ORDER BY f."id" LIMIT 1000`,
        [summaries[0].audit_reference],
      );
      report.file_list_truncated =
        BigInt(summaries[0].registered_files) > BigInt(report.files.length);
      for (const file of report.files) {
        if (file.has_encrypted_metadata !== null) {
          file.has_encrypted_metadata =
            file.has_encrypted_metadata === true ||
            Number(file.has_encrypted_metadata) === 1;
        }
      }
    }
    console.log(
      JSON.stringify(
        report,
        (_key, value) => (typeof value === "bigint" ? value.toString() : value),
        2,
      ),
    );
    if (!list && summaries.length !== 1) process.exitCode = 3;
  } catch (error) {
    // Database error messages may contain connection data. Print only known codes.
    const known = new Set([
      "DATABASE_URL_MISSING",
      "SCHEMA_UNSUPPORTED",
      "SQLITE_PATH_UNAVAILABLE",
      "DATABASE_TYPE_UNSUPPORTED",
      "SCHEMA_INCOMPATIBLE",
    ]);
    console.error(
      `Diagnostic interrupted (${known.has(error.message) ? error.message : "DATABASE_READ_FAILED"}). Check the application container and run from /opt/app/backend. No secret is displayed.`,
    );
    process.exitCode = 1;
  } finally {
    if (inTransaction) {
      try {
        await query("ROLLBACK");
      } catch {
        /* The connection may already be closed. */
      }
    }
    if (database) {
      try {
        if (typeof database.end === "function") await database.end();
        else database.close();
      } catch {
        /* Keep the original diagnostic result. */
      }
    }
  }
}

main();
