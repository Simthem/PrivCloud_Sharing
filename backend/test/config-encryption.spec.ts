import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "@prisma/client";
import {
  applyConfigEncryption,
  isSealedValue,
  loadConfigKey,
  openRows,
  openValue,
  sealValue,
} from "src/config/config-encryption";
import { ConfigService } from "src/config/config.service";
import { createUnitTestRunner } from "./unit-test";

const { testCase, run } = createUnitTestRunner("Encrypted settings");

const key = randomBytes(32);
const quiet = { log() {} } as never;

function store(rows: Partial<Config>[]) {
  const stored = rows as Config[];
  return {
    rows: stored,
    config: {
      findMany: async () => stored.map((row) => ({ ...row })),
      updateMany: async ({
        where,
        data,
      }: {
        where: { category: string; name: string; value: string };
        data: { value: string };
      }) => {
        for (const row of stored) {
          if (
            row.category === where.category &&
            row.name === where.name &&
            row.value === where.value
          ) {
            row.value = data.value;
          }
        }
      },
    },
  };
}

const secret = () => ({ category: "s3", name: "secret", value: "s3cret" });
const plain = () => ({ category: "general", name: "appName", value: "App" });

testCase("a value opens only with its key and under its name", () => {
  const sealed = sealValue(key, "s3", "secret", "s3cret");
  assert.equal(isSealedValue(sealed), true);
  assert.doesNotMatch(sealed, /s3cret/);
  assert.equal(openValue(key, "s3", "secret", sealed), "s3cret");
  assert.notEqual(sealed, sealValue(key, "s3", "secret", "s3cret"));
  assert.throws(() => openValue(randomBytes(32), "s3", "secret", sealed));
  assert.throws(() => openValue(key, "s3", "key", sealed));
  assert.throws(() => openValue(null, "s3", "secret", sealed));
});

testCase("without a key nothing changes", async () => {
  const database = store([secret(), plain()]);
  await applyConfigEncryption(database, null, quiet);
  assert.equal(database.rows[0].value, "s3cret");
  assert.deepEqual(
    openRows([secret() as Config], null).map((row) => row.value),
    ["s3cret"],
  );
});

testCase("only listed secrets are sealed, and only once", async () => {
  const database = store([
    secret(),
    plain(),
    { category: "smtp", name: "password", value: null },
  ]);
  await applyConfigEncryption(database, key, quiet);
  const sealed = database.rows[0].value as string;
  assert.equal(isSealedValue(sealed), true);
  assert.equal(database.rows[1].value, "App");
  assert.equal(database.rows[2].value, null);

  await applyConfigEncryption(database, key, quiet);
  assert.equal(database.rows[0].value, sealed);
  assert.equal(
    openRows(database.rows, key)[0].value,
    "s3cret",
    "the stored value still opens",
  );
});

testCase("decrypt mode restores plaintext rows", async () => {
  const database = store([secret()]);
  await applyConfigEncryption(database, key, quiet);
  process.env.CONFIG_ENCRYPTION_MODE = "decrypt";
  try {
    await applyConfigEncryption(database, key, quiet);
  } finally {
    delete process.env.CONFIG_ENCRYPTION_MODE;
  }
  assert.equal(database.rows[0].value, "s3cret");
});

testCase("a concurrent edit is not overwritten", async () => {
  const database = store([secret()]);
  const { findMany } = database.config;
  database.config.findMany = async () => {
    const rows = await findMany();
    database.rows[0].value = "edited";
    return rows;
  };
  await applyConfigEncryption(database, key, quiet);
  assert.equal(database.rows[0].value, "edited");
});

testCase("an admin edit is stored sealed and stays readable", async () => {
  const directory = mkdtempSync(join(tmpdir(), "config-key-"));
  const file = join(directory, "config.key");
  writeFileSync(file, key.toString("base64"));
  process.env.CONFIG_ENCRYPTION_KEY_FILE = file;
  try {
    const row = {
      category: "smtp",
      name: "password",
      type: "string",
      value: null,
      defaultValue: "",
      locked: false,
      secret: true,
    } as unknown as Config;
    const prisma = {
      config: {
        findUnique: async () => row,
        findMany: async () => [row],
        update: async ({ data }: { data: { value: string } }) => {
          row.value = data.value;
          return row;
        },
      },
    };
    const service = new ConfigService([row], prisma as never);
    const updated = await service.update("smtp.password", "hunter2");

    assert.equal(isSealedValue(row.value), true);
    assert.equal(updated.value, "hunter2");
    assert.equal(service.get("smtp.password"), "hunter2");
  } finally {
    delete process.env.CONFIG_ENCRYPTION_KEY_FILE;
    rmSync(directory, { recursive: true });
  }
});

testCase("the key file must exist and hold 32 bytes", () => {
  const directory = mkdtempSync(join(tmpdir(), "config-key-"));
  try {
    const file = join(directory, "config.key");
    writeFileSync(file, `${key.toString("base64")}\n`);
    process.env.CONFIG_ENCRYPTION_KEY_FILE = file;
    assert.deepEqual(loadConfigKey(), key);

    writeFileSync(file, "short");
    assert.throws(() => loadConfigKey());

    process.env.CONFIG_ENCRYPTION_KEY_FILE = join(directory, "missing");
    assert.throws(() => loadConfigKey());
  } finally {
    delete process.env.CONFIG_ENCRYPTION_KEY_FILE;
    rmSync(directory, { recursive: true });
  }
  assert.equal(loadConfigKey(), null);
});

void run();
