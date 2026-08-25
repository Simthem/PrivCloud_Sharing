import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const backendDirectory = resolve(
  process.env.PRIVCLOUD_BACKEND_DIRECTORY || "/opt/app/backend",
);
const prismaCli = `${backendDirectory}/node_modules/prisma/build/index.js`;
const seedScript = `${backendDirectory}/prisma/seed/config.seed.ts`;
const sqliteDatabase = resolve(
  process.env.PRIVCLOUD_SQLITE_DATABASE ||
    `${backendDirectory}/data/pingvin-share.db`,
);
const backendRequire = createRequire(`${backendDirectory}/package.json`);

function spawnProcess(command, args, options = {}) {
  return spawn(command, args, {
    cwd: options.cwd || "/opt/app",
    env: options.env || process.env,
    stdio: "inherit",
  });
}

function waitForProcess(child, label) {
  return new Promise((resolve) => {
    child.once("error", (error) => resolve({ label, code: 1, error }));
    child.once("exit", (code, signal) =>
      resolve({ label, code: code ?? 1, signal }),
    );
  });
}

async function run(command, args, options = {}) {
  const child = spawnProcess(command, args, options);
  const result = await waitForProcess(child, command);
  if (result.error) throw result.error;
  if (result.code !== 0) {
    throw new Error(`${command} exited with code ${result.code}`);
  }
}

function fileDiagnostic(label, path) {
  if (!existsSync(path)) {
    console.log(`  ${label.padEnd(8)}: absent`);
    return;
  }
  const stats = statSync(path);
  console.log(
    `  ${label.padEnd(8)}: ${stats.size} bytes${label === "db" ? `  inode=${stats.ino}` : ""}`,
  );
}

function databaseDiagnostic(label) {
  console.log(`=== DB DIAG [${label}] ===`);
  console.log(`  cwd     : ${backendDirectory}`);
  fileDiagnostic("db", sqliteDatabase);
  fileDiagnostic("wal", `${sqliteDatabase}-wal`);
  fileDiagnostic("shm", `${sqliteDatabase}-shm`);

  if (existsSync(sqliteDatabase)) {
    let database;
    try {
      const Database = backendRequire("better-sqlite3");
      database = new Database(sqliteDatabase, { readonly: true });
      const users = database.prepare("SELECT count(*) AS c FROM User").get();
      const reverseShares = database
        .prepare("SELECT count(*) AS c FROM ReverseShare")
        .get();
      const usersWithKey = database
        .prepare(
          "SELECT count(*) AS c FROM User WHERE encryptionKeyHash IS NOT NULL",
        )
        .get();
      console.log(`  users   : ${users.c} (with E2E key: ${usersWithKey.c})`);
      console.log(`  revShare: ${reverseShares.c}`);
    } catch (error) {
      console.log(`  query   : skip (${error.message.slice(0, 80)})`);
    } finally {
      database?.close();
    }
  }
  console.log(`=== END DIAG [${label}] ===`);
}

function ensureSqliteDatabase(databasePath = sqliteDatabase) {
  if (existsSync(databasePath)) return false;
  mkdirSync(dirname(databasePath), { recursive: true });
  const Database = backendRequire("better-sqlite3");
  const database = new Database(databasePath);
  database.close();
  return true;
}

function sqliteColumnExists(database, table, column) {
  try {
    const escapedTable = table.replaceAll('"', '""');
    return database
      .prepare(`PRAGMA table_info("${escapedTable}")`)
      .all()
      .some((entry) => entry.name === column);
  } catch {
    return false;
  }
}

function sqliteTableExists(database, table) {
  try {
    return Boolean(
      database
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
        .get(table),
    );
  } catch {
    return false;
  }
}

function sqliteIndexExists(database, index) {
  try {
    return Boolean(
      database
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name=?")
        .get(index),
    );
  } catch {
    return false;
  }
}

const publicParityColumns = [
  ["Team", "reportEnabled"],
  ["Team", "keyVersion"],
  ["Team", "keyRotatedAt"],
  ["Team", "keyRotationIntervalDays"],
  ["Team", "keyRotationReminderDays"],
  ["Team", "lastKeyRotationReminderAt"],
  ["TeamMember", "teamKeyVersion"],
  ["TeamMember", "teamKeyUpdatedAt"],
  ["TeamAccessLog", "targetType"],
  ["TeamAccessLog", "targetId"],
  ["TeamAccessLog", "metadata"],
  ["File", "encryptionChunkSize"],
  ["SignatureDocument", "certificatePageKey"],
  ["SignatureDocument", "completedAt"],
  ["SignatureDocument", "signaturePage"],
  ["SignatureDocument", "watermarkPage"],
  ["SignatureDocument", "fileDeletedAt"],
];

const publicParityIndexes = [
  "TeamAuditReport_teamId_frequency_periodStart_periodEnd_key",
  "TeamAuditReport_teamId_createdAt_idx",
  "TeamKeyRotation_teamId_status_idx",
  "TeamKeyRotation_teamId_createdAt_idx",
  "TeamAccessLog_teamId_createdAt_idx",
  "TeamAccessLog_teamId_action_createdAt_idx",
  "Share_teamFolderId_uploadLocked_createdAt_idx",
  "Share_creatorId_teamFolderId_uploadLocked_idx",
  "File_shareId_idx",
  "SignatureDocument_teamId_createdAt_idx",
  "TeamFolder_teamId_parentId_idx",
  "AccessGrant_userId_status_createdAt_idx",
  "AccessGrant_grantorId_status_createdAt_idx",
];

function publicParitySchemaIsReady(database) {
  return (
    publicParityColumns.every(([table, column]) =>
      sqliteColumnExists(database, table, column),
    ) &&
    ["TeamAuditReport", "TeamKeyRotation"].every((table) =>
      sqliteTableExists(database, table),
    ) &&
    publicParityIndexes.every((index) => sqliteIndexExists(database, index))
  );
}

function repairFailedPublicParityMigration(database) {
  const migrationName = "20260721120000_add_public_team_signing_parity";
  const row = database
    .prepare(
      "SELECT id, finished_at, rolled_back_at FROM _prisma_migrations WHERE migration_name = ?",
    )
    .get(migrationName);
  if (!row || row.finished_at || row.rolled_back_at) return false;

  console.log(
    `[entrypoint] ${migrationName}: repairing partially applied SQLite migration`,
  );

  const repair = database.transaction(() => {
    const ensureColumn = (table, column, definition) => {
      if (!sqliteColumnExists(database, table, column)) {
        database.exec(`ALTER TABLE "${table}" ADD COLUMN ${definition}`);
      }
    };

    ensureColumn(
      "Team",
      "reportEnabled",
      '"reportEnabled" BOOLEAN NOT NULL DEFAULT true',
    );
    ensureColumn(
      "Team",
      "keyVersion",
      '"keyVersion" INTEGER NOT NULL DEFAULT 1',
    );
    ensureColumn("Team", "keyRotatedAt", '"keyRotatedAt" DATETIME');
    ensureColumn(
      "Team",
      "keyRotationIntervalDays",
      '"keyRotationIntervalDays" INTEGER NOT NULL DEFAULT 90',
    );
    ensureColumn(
      "Team",
      "keyRotationReminderDays",
      '"keyRotationReminderDays" INTEGER NOT NULL DEFAULT 7',
    );
    ensureColumn(
      "Team",
      "lastKeyRotationReminderAt",
      '"lastKeyRotationReminderAt" DATETIME',
    );
    ensureColumn(
      "TeamMember",
      "teamKeyVersion",
      '"teamKeyVersion" INTEGER NOT NULL DEFAULT 0',
    );
    ensureColumn(
      "TeamMember",
      "teamKeyUpdatedAt",
      '"teamKeyUpdatedAt" DATETIME',
    );
    ensureColumn("TeamAccessLog", "targetType", '"targetType" TEXT');
    ensureColumn("TeamAccessLog", "targetId", '"targetId" TEXT');
    ensureColumn("TeamAccessLog", "metadata", '"metadata" TEXT');
    ensureColumn(
      "File",
      "encryptionChunkSize",
      '"encryptionChunkSize" INTEGER',
    );
    ensureColumn(
      "SignatureDocument",
      "certificatePageKey",
      '"certificatePageKey" TEXT',
    );
    ensureColumn("SignatureDocument", "completedAt", '"completedAt" DATETIME');
    ensureColumn(
      "SignatureDocument",
      "signaturePage",
      '"signaturePage" INTEGER',
    );
    ensureColumn(
      "SignatureDocument",
      "watermarkPage",
      '"watermarkPage" INTEGER',
    );
    ensureColumn(
      "SignatureDocument",
      "fileDeletedAt",
      '"fileDeletedAt" DATETIME',
    );

    database.exec(`
      UPDATE "TeamMember"
      SET "teamKeyVersion" = 1,
          "teamKeyUpdatedAt" = "updatedAt"
      WHERE "wrappedTeamKey" IS NOT NULL;

      UPDATE "Team"
      SET "keyRotatedAt" = "createdAt"
      WHERE EXISTS (
        SELECT 1 FROM "TeamMember"
        WHERE "TeamMember"."teamId" = "Team"."id"
          AND "TeamMember"."wrappedTeamKey" IS NOT NULL
      );

      CREATE TABLE IF NOT EXISTS "TeamAuditReport" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "frequency" TEXT NOT NULL,
        "periodStart" DATETIME NOT NULL,
        "periodEnd" DATETIME NOT NULL,
        "status" TEXT NOT NULL DEFAULT 'GENERATED',
        "summary" TEXT NOT NULL,
        "recipientEmails" TEXT NOT NULL,
        "sentAt" DATETIME,
        "error" TEXT,
        "teamId" TEXT NOT NULL,
        CONSTRAINT "TeamAuditReport_teamId_fkey"
          FOREIGN KEY ("teamId") REFERENCES "Team" ("id")
          ON DELETE CASCADE ON UPDATE CASCADE
      );

      CREATE TABLE IF NOT EXISTS "TeamKeyRotation" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" DATETIME NOT NULL,
        "fromVersion" INTEGER NOT NULL,
        "toVersion" INTEGER NOT NULL,
        "status" TEXT NOT NULL DEFAULT 'PREPARING',
        "reason" TEXT NOT NULL DEFAULT 'MANUAL',
        "startedById" TEXT NOT NULL,
        "initiatorWrappedKey" TEXT NOT NULL,
        "totalFiles" INTEGER NOT NULL DEFAULT 0,
        "processedFiles" INTEGER NOT NULL DEFAULT 0,
        "failedFiles" INTEGER NOT NULL DEFAULT 0,
        "completedFileIds" TEXT NOT NULL DEFAULT '[]',
        "errorMessage" TEXT,
        "completedAt" DATETIME,
        "teamId" TEXT NOT NULL,
        CONSTRAINT "TeamKeyRotation_teamId_fkey"
          FOREIGN KEY ("teamId") REFERENCES "Team" ("id")
          ON DELETE CASCADE ON UPDATE CASCADE
      );

      CREATE UNIQUE INDEX IF NOT EXISTS "TeamAuditReport_teamId_frequency_periodStart_periodEnd_key"
        ON "TeamAuditReport"("teamId", "frequency", "periodStart", "periodEnd");
      CREATE INDEX IF NOT EXISTS "TeamAuditReport_teamId_createdAt_idx"
        ON "TeamAuditReport"("teamId", "createdAt");
      CREATE INDEX IF NOT EXISTS "TeamKeyRotation_teamId_status_idx"
        ON "TeamKeyRotation"("teamId", "status");
      CREATE INDEX IF NOT EXISTS "TeamKeyRotation_teamId_createdAt_idx"
        ON "TeamKeyRotation"("teamId", "createdAt");
      CREATE INDEX IF NOT EXISTS "TeamAccessLog_teamId_createdAt_idx"
        ON "TeamAccessLog"("teamId", "createdAt");
      CREATE INDEX IF NOT EXISTS "TeamAccessLog_teamId_action_createdAt_idx"
        ON "TeamAccessLog"("teamId", "action", "createdAt");
      CREATE INDEX IF NOT EXISTS "Share_teamFolderId_uploadLocked_createdAt_idx"
        ON "Share"("teamFolderId", "uploadLocked", "createdAt");
      CREATE INDEX IF NOT EXISTS "Share_creatorId_teamFolderId_uploadLocked_idx"
        ON "Share"("creatorId", "teamFolderId", "uploadLocked");
      CREATE INDEX IF NOT EXISTS "File_shareId_idx" ON "File"("shareId");
      CREATE INDEX IF NOT EXISTS "SignatureDocument_teamId_createdAt_idx"
        ON "SignatureDocument"("teamId", "createdAt");
      CREATE INDEX IF NOT EXISTS "TeamFolder_teamId_parentId_idx"
        ON "TeamFolder"("teamId", "parentId");
      CREATE INDEX IF NOT EXISTS "AccessGrant_userId_status_createdAt_idx"
        ON "AccessGrant"("userId", "status", "createdAt");
      CREATE INDEX IF NOT EXISTS "AccessGrant_grantorId_status_createdAt_idx"
        ON "AccessGrant"("grantorId", "status", "createdAt");
    `);

    if (!publicParitySchemaIsReady(database)) {
      throw new Error(`${migrationName}: repaired schema is incomplete`);
    }

    database
      .prepare(
        "UPDATE _prisma_migrations SET finished_at = ?, logs = NULL, applied_steps_count = 1 WHERE id = ?",
      )
      .run(Date.now(), row.id);
  });

  repair();
  console.log(`[entrypoint] ${migrationName}: repair completed`);
  return true;
}

function reconcileSqliteMigrations(databasePath = sqliteDatabase) {
  if (!existsSync(databasePath)) return;

  let database;
  try {
    const Database = backendRequire("better-sqlite3");
    database = new Database(databasePath);
    const hasMigrationTable = database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='_prisma_migrations'",
      )
      .get();
    if (!hasMigrationTable) return;

    const columnExists = (table, column) =>
      sqliteColumnExists(database, table, column);
    const tableExists = (name) => sqliteTableExists(database, name);

    repairFailedPublicParityMigration(database);

    // This removed migration targeted SaaS tables that were already absent.
    // Resolve its stale failed record without touching application data.
    const abandonedMigration = "20260522150000_remove_saas_fields";
    const abandonedRow = database
      .prepare(
        "SELECT id, finished_at, rolled_back_at FROM _prisma_migrations WHERE migration_name = ?",
      )
      .get(abandonedMigration);
    if (
      abandonedRow &&
      !abandonedRow.finished_at &&
      !abandonedRow.rolled_back_at
    ) {
      console.log(
        `[entrypoint] ${abandonedMigration}: marking removed failed migration as rolled back`,
      );
      database
        .prepare(
          "UPDATE _prisma_migrations SET rolled_back_at = datetime('now'), logs = 'Migration removed from repository: operated on tables that no longer existed at migration time.' WHERE id = ?",
        )
        .run(abandonedRow.id);
    }

    const migrations = [
      [
        "20260716140000_add_folder_access_granular_perms",
        () =>
          columnExists("TeamFolderAccess", "canDownload") &&
          columnExists("TeamFolderAccess", "canDelete"),
      ],
      [
        "20260716150000_add_file_access_and_signature_perms",
        () =>
          tableExists("FileAccess") &&
          columnExists("TeamFolderAccess", "canRequestSignature"),
      ],
      [
        "20260716120000_add_member_feature_permissions",
        () =>
          columnExists("TeamMember", "canViewActivity") &&
          columnExists("TeamMember", "canViewSignatures"),
      ],
      [
        "20260721120000_add_public_team_signing_parity",
        () => publicParitySchemaIsReady(database),
      ],
    ];

    for (const [migrationName, schemaIsReady] of migrations) {
      const row = database
        .prepare(
          "SELECT id, finished_at, rolled_back_at FROM _prisma_migrations WHERE migration_name = ?",
        )
        .get(migrationName);
      if (!row && schemaIsReady()) {
        console.log(
          `[entrypoint] ${migrationName}: schema present, marking migration as applied`,
        );
        database
          .prepare(
            "INSERT INTO _prisma_migrations (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count) VALUES (?, ?, datetime('now'), ?, NULL, NULL, datetime('now'), 1)",
          )
          .run(randomUUID(), "", migrationName);
      } else if (
        row &&
        !row.finished_at &&
        !row.rolled_back_at &&
        schemaIsReady()
      ) {
        console.log(
          `[entrypoint] ${migrationName}: schema present, resolving failed migration`,
        );
        database
          .prepare(
            "UPDATE _prisma_migrations SET finished_at = datetime('now'), logs = NULL, applied_steps_count = 1 WHERE id = ?",
          )
          .run(row.id);
      }
    }
  } catch (error) {
    console.log(
      `[entrypoint] migration-reconcile error: ${error.message.slice(0, 200)}`,
    );
  } finally {
    database?.close();
  }
}

async function seed() {
  await run(
    "node",
    ["--require", "ts-node/register/transpile-only", seedScript],
    { cwd: backendDirectory },
  );
}

async function migrate(includeSeed) {
  ensureSqliteDatabase();
  databaseDiagnostic("before-migrate");
  reconcileSqliteMigrations();
  await run("node", [prismaCli, "migrate", "deploy"], {
    cwd: backendDirectory,
  });
  databaseDiagnostic("after-migrate");
  if (includeSeed) {
    await seed();
    databaseDiagnostic("after-seed");
  }
}

function backendNodeOptions() {
  let options = process.env.NODE_OPTIONS || "";
  if (!options.includes("--dns-result-order=")) {
    options = `--dns-result-order=${process.env.NODE_DNS_RESULT_ORDER || "ipv4first"}${options ? ` ${options}` : ""}`;
  }
  if (!options.includes("global-agent/bootstrap")) {
    options = `${options} --require ./node_modules/global-agent/bootstrap`;
  }
  return `--max-old-space-size=${process.env.NODE_MAX_OLD_SPACE_SIZE || "3072"} ${options}`;
}

async function runServer() {
  if (process.env.RUN_DB_MIGRATIONS !== "false") {
    console.log("Running database migrations before server start...");
    await migrate(true);
  } else {
    console.log("RUN_DB_MIGRATIONS=false: skipping automatic migrations.");
  }

  const children = [];
  if (process.env.CADDY_DISABLED !== "true") {
    console.log("Starting Caddy...");
    const config =
      process.env.TRUST_PROXY === "true"
        ? "/opt/app/reverse-proxy/Caddyfile.trust-proxy"
        : "/opt/app/reverse-proxy/Caddyfile";
    children.push({
      label: "caddy",
      child: spawnProcess(
        "/usr/bin/caddy",
        ["run", "--adapter", "caddyfile", "--config", config],
        { cwd: "/opt/app" },
      ),
    });
  } else {
    console.log("Caddy is disabled. Skipping...");
  }

  children.push({
    label: "frontend",
    child: spawnProcess("node", ["frontend/server.js"], {
      cwd: "/opt/app",
      env: {
        ...process.env,
        NODE_OPTIONS: "",
        PORT: "3333",
        HOSTNAME: "0.0.0.0",
      },
    }),
  });
  children.push({
    label: "backend",
    child: spawnProcess("node", ["dist/src/main"], {
      cwd: backendDirectory,
      env: { ...process.env, NODE_OPTIONS: backendNodeOptions() },
    }),
  });

  let resolveSignal;
  const signalPromise = new Promise((resolve) => {
    resolveSignal = resolve;
  });
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP", "SIGQUIT"]) {
    process.once(signal, () => resolveSignal({ label: "runtime", signal }));
  }

  const childCompletions = children.map(({ child, label }) =>
    waitForProcess(child, label),
  );
  const result = await Promise.race([signalPromise, ...childCompletions]);
  if (result.error) console.error(`${result.label}:`, result.error);
  if (result.label !== "runtime") {
    console.error(
      `${result.label} stopped unexpectedly (code=${result.code}, signal=${result.signal || "none"})`,
    );
  }

  const stopSignal = result.signal || "SIGTERM";
  for (const { child } of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill(stopSignal);
    }
  }
  await Promise.all(childCompletions);
  if (result.label !== "runtime") process.exitCode = result.code || 1;
}

async function main() {
  const task = process.env.PRIVCLOUD_TASK || "server";
  if (task === "migrate") return migrate(true);
  if (task === "migrate-schema") return migrate(false);
  if (task === "seed") {
    databaseDiagnostic("before-seed");
    await seed();
    databaseDiagnostic("after-seed");
    return;
  }
  if (task !== "server") throw new Error(`Unknown PRIVCLOUD_TASK: ${task}`);
  return runServer();
}

const isMain =
  process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

export {
  ensureSqliteDatabase,
  publicParitySchemaIsReady,
  reconcileSqliteMigrations,
  repairFailedPublicParityMigration,
};
