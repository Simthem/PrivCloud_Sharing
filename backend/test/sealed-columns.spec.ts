import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  convertSealedColumns,
  emailFold,
  openResult,
  rewriteData,
  rewriteWhere,
  runSealed,
  SEALED_COLUMNS,
  uniqueVariants,
} from "src/prisma/sealed-columns";
import {
  sealAccountSecret,
  sealToken,
  tokenCandidates,
} from "src/config/account-secrets";
import { createUnitTestRunner } from "./unit-test";

const { testCase, run } = createUnitTestRunner("Sealed columns");

const key = randomBytes(32);
const email = "someone@example.test";
const quiet = { log() {}, warn() {} } as never;

function withKey(mode: string | undefined, body: () => Promise<void> | void) {
  return async () => {
    const directory = mkdtempSync(join(tmpdir(), "column-key-"));
    const file = join(directory, "config.key");
    writeFileSync(file, key.toString("base64"));
    process.env.CONFIG_ENCRYPTION_KEY_FILE = file;
    if (mode) process.env.CONFIG_ENCRYPTION_MODE = mode;
    try {
      await body();
    } finally {
      delete process.env.CONFIG_ENCRYPTION_KEY_FILE;
      delete process.env.CONFIG_ENCRYPTION_MODE;
      rmSync(directory, { recursive: true });
    }
  };
}

const sealedEmail = () =>
  (rewriteData(key, "User", { email }, true) as { email: string }).email;

testCase("every declared column can hold its sealed form", () => {
  const schema = readFileSync("prisma/schema.prisma", "utf8");
  for (const [model, columns] of Object.entries(SEALED_COLUMNS)) {
    const body = new RegExp(`^model ${model} \\{(.*?)^\\}`, "ms").exec(
      schema,
    )?.[1];
    assert.ok(body, model);
    const primaryKey = model === "EmailVerificationToken" ? "tokenHash" : "id";
    assert.match(body, new RegExp(`^\\s+${primaryKey}\\s+String\\s+@id`, "m"));
    for (const name of Object.keys(columns)) {
      const line = new RegExp(`^\\s+${name}\\s+String\\??(.*)$`, "m").exec(
        body,
      );
      assert.ok(line, `${model}.${name}`);
      assert.doesNotMatch(line[1], /@db\.|@id/, `${model}.${name}`);
    }
  }
});

testCase(
  "writes are sealed only in full mode",
  withKey("full", () => {
    const data = rewriteData(key, "User", { email, isAdmin: true }, true) as {
      email: string;
      emailFold: string;
      isAdmin: boolean;
    };
    assert.notEqual(data.email, email);
    assert.equal(data.email.includes("someone"), false);
    assert.equal(data.emailFold, emailFold(key, "SomeOne@Example.test"));
    assert.equal(data.isAdmin, true);
    assert.deepEqual(rewriteData(key, "User", { email }, false), { email });
  }),
);

testCase(
  "nested writes reach their own model",
  withKey("full", () => {
    const data = rewriteData(
      key,
      "SignatureDocument",
      {
        title: "Contract",
        recipients: { create: [{ email, name: "Someone", order: 1 }] },
      },
      true,
    ) as { title: string; recipients: { create: Record<string, string>[] } };
    assert.notEqual(data.title, "Contract");
    assert.notEqual(data.recipients.create[0].email, email);
    assert.notEqual(data.recipients.create[0].name, "Someone");
  }),
);

testCase(
  "a lookup matches both stored forms",
  withKey("full", () => {
    const where = rewriteWhere(key, "User", { email, isAdmin: true }) as {
      email: { in: string[] };
      isAdmin: boolean;
    };
    assert.deepEqual(where.email.in, [sealedEmail(), email]);
    assert.equal(where.isAdmin, true);
  }),
);

testCase(
  "relation filters and logic follow the model",
  withKey("full", () => {
    const where = rewriteWhere(key, "SignatureDocument", {
      OR: [{ creatorId: "user-1" }, { recipients: { some: { email } } }],
    }) as {
      OR: [unknown, { recipients: { some: { email: { in: string[] } } } }];
    };
    assert.equal(where.OR[1].recipients.some.email.in.length, 2);
  }),
);

testCase(
  "null checks pass, a search on free text is refused",
  withKey("full", () => {
    assert.deepEqual(rewriteWhere(key, "Share", { description: null }), {
      description: null,
    });
    assert.throws(() => rewriteWhere(key, "Share", { description: "x" }));
    assert.throws(() =>
      rewriteWhere(key, "User", { email: { contains: "some" } }),
    );
  }),
);

testCase(
  "an address ignoring case uses its fold",
  withKey("full", () => {
    const where = rewriteWhere(key, "User", {
      email: { equals: "SOMEONE@example.test", mode: "insensitive" },
    }) as { AND: [unknown, { OR: [{ emailFold: string }, unknown] }] };
    assert.equal(where.AND[1].OR[0].emailFold, emailFold(key, email));
  }),
);

testCase(
  "unique lookups try the likely form first",
  withKey("full", () => {
    const sealed = sealedEmail();
    assert.deepEqual(
      uniqueVariants(key, "User", { email }, true).map((v) => v.email),
      [sealed, email],
    );
    assert.deepEqual(
      uniqueVariants(key, "User", { email }, false).map((v) => v.email),
      [email, sealed],
    );
    const compound = uniqueVariants(
      key,
      "TeamInvitation",
      { email_teamId: { email, teamId: "team-1" } },
      true,
    );
    assert.equal(compound.length, 2);
    assert.deepEqual(uniqueVariants(key, "User", { id: "user-1" }, true), [
      { id: "user-1" },
    ]);
  }),
);

testCase(
  "a row in the other form is still found and updated",
  withKey("full", async () => {
    const seen: unknown[] = [];
    const row = await runSealed(
      key,
      "User",
      "update",
      {
        where: { email },
        data: { username: "new" },
      },
      async (args) => {
        const { where } = args as { where: { email: string } };
        seen.push(where.email);
        if (where.email !== email) {
          throw Object.assign(new Error("missing"), { code: "P2025" });
        }
        return { id: "user-1", email };
      },
    );
    assert.deepEqual(seen, [sealedEmail(), email]);
    assert.deepEqual(row, { id: "user-1", email });
  }),
);

testCase(
  "results open through relations and keep plain rows",
  withKey("full", () => {
    const stored = rewriteData(
      key,
      "User",
      { email, username: "someone" },
      true,
    );
    const opened = openResult(key, "Share", {
      id: "share-1",
      creator: stored,
      recipients: [{ email }],
    }) as {
      creator: { email: string; username: string };
      recipients: unknown[];
    };
    assert.equal(opened.creator.email, email);
    assert.equal(opened.creator.username, "someone");
    assert.deepEqual(opened.recipients, [{ email }]);
  }),
);

testCase(
  "text that merely looks sealed is returned as it is",
  withKey("full", () => {
    assert.deepEqual(openResult(key, "File", { name: "enc:d1:report.pdf" }), {
      name: "enc:d1:report.pdf",
    });
  }),
);

function storeOf(rows: Record<string, Record<string, string | null>[]>) {
  const client: Record<string, unknown> = {};
  for (const model of Object.keys(SEALED_COLUMNS)) {
    const name = model[0].toLowerCase() + model.slice(1);
    const table = (rows[name] ??= []);
    client[name] = {
      findMany: async ({
        where,
        take,
      }: {
        where: Record<string, { gt?: string; startsWith?: string }> & {
          NOT?: Record<string, { startsWith: string }>;
        };
        take: number;
      }) => {
        const [id, field] = [
          Object.keys(where).find((k) => where[k]?.gt !== undefined) as string,
          Object.keys(where.NOT ?? where).find(
            (k) => (where.NOT ?? where)[k]?.startsWith,
          ) as string,
        ];
        return table
          .filter(
            (row) =>
              (row[id] as string) > (where[id].gt as string) &&
              row[field] !== undefined &&
              row[field] !== null &&
              (row[field] as string).startsWith("enc:") === !where.NOT,
          )
          .sort((a, b) => ((a[id] as string) > (b[id] as string) ? 1 : -1))
          .slice(0, take)
          .map((row) => ({ ...row }));
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: Record<string, string>;
        data: Record<string, string | null>;
      }) => {
        let count = 0;
        for (const row of table) {
          if (Object.keys(where).every((k) => row[k] === where[k])) {
            Object.assign(row, data);
            count++;
          }
        }
        return { count };
      },
    };
  }
  return client as never;
}

testCase(
  "stored rows are converted once, then restored",
  withKey("full", async () => {
    const rows = {
      user: [
        { id: "user-1", email, username: "someone", emailFold: null },
        {
          id: "user-2",
          email: "b@example.test",
          username: "b",
          emailFold: null,
        },
      ],
      file: [{ id: "file-1", name: "report.pdf", relativePath: null }],
    };
    const client = storeOf(rows);
    await convertSealedColumns(client, key, quiet);
    assert.equal(rows.user[0].email.startsWith("enc:"), true);
    assert.equal(rows.user[0].emailFold, emailFold(key, email));
    assert.equal(rows.file[0].name.startsWith("enc:"), true);
    assert.equal(rows.file[0].relativePath, null);
    const sealed = rows.user[0].email;

    await convertSealedColumns(client, key, quiet);
    assert.equal(rows.user[0].email, sealed);

    process.env.CONFIG_ENCRYPTION_MODE = "decrypt";
    await convertSealedColumns(client, key, quiet);
    assert.equal(rows.user[0].email, email);
    assert.equal(rows.user[0].emailFold, null);
    assert.equal(rows.file[0].name, "report.pdf");
  }),
);

testCase(
  "values pinned by a check constraint stay as they are",
  withKey("full", async () => {
    const placeholder = "encrypted-file-1a2b3c4d";
    assert.deepEqual(
      rewriteData(key, "File", { name: placeholder, relativePath: null }, true),
      { name: placeholder, relativePath: null },
    );
    const named = rewriteData(key, "File", { name: "encrypted-file-x" }, true);
    assert.equal((named as { name: string }).name.startsWith("enc:"), true);
    assert.deepEqual(
      rewriteData(key, "TeamFileRequest", { subject: "", note: null }, true),
      { subject: "", note: null },
    );
    const subject = rewriteData(
      key,
      "TeamFileRequest",
      { subject: "Q3" },
      true,
    );
    assert.equal(
      (subject as { subject: string }).subject.startsWith("enc:"),
      true,
    );

    const rows = {
      file: [
        { id: "file-1", name: placeholder, relativePath: null },
        { id: "file-2", name: "report.pdf", relativePath: null },
      ],
    };
    const writes: string[] = [];
    const client = storeOf(rows) as unknown as {
      file: { updateMany: (args: { where: { id: string } }) => unknown };
    };
    const updateMany = client.file.updateMany;
    client.file.updateMany = (args) => {
      writes.push(args.where.id);
      return updateMany(args);
    };
    await convertSealedColumns(client as never, key, quiet);
    assert.equal(rows.file[0].name, placeholder);
    assert.equal(rows.file[1].name.startsWith("enc:"), true);
    assert.deepEqual(writes, ["file-2"]);
  }),
);

testCase(
  "link tokens and account secrets read back in clear",
  withKey("full", () => {
    const token = randomUUID();
    const totp = randomBytes(10).toString("hex");
    const stored = sealToken("signing", token);
    assert.equal(stored.startsWith("enc:d1:"), true);
    const secret = sealAccountSecret("user-1", "totpSecret", totp);
    assert.deepEqual(
      openResult(key, "SignatureDocument", {
        id: "doc",
        recipients: [{ id: "r1", signingToken: stored }],
        creator: { id: "user-1", totpSecret: secret },
      }),
      {
        id: "doc",
        recipients: [{ id: "r1", signingToken: token }],
        creator: { id: "user-1", totpSecret: totp },
      },
    );
    // Without its owner a secret cannot be opened, and stays as stored.
    assert.deepEqual(openResult(key, "User", { totpSecret: secret }), {
      totpSecret: secret,
    });
  }),
);

testCase(
  "link tokens are sealed on write and found from their clear form",
  withKey("full", () => {
    const token = randomUUID();
    const stored = sealToken("invitation", token);
    assert.deepEqual(
      rewriteData(key, "TeamInvitation", { token, email }, true),
      {
        token: stored,
        email: (
          rewriteData(key, "TeamInvitation", { email }, true) as {
            email: string;
          }
        ).email,
      },
    );
    assert.deepEqual(
      rewriteData(key, "TeamInvitation", { token: stored }, true),
      { token: stored },
    );
    assert.deepEqual(rewriteWhere(key, "TeamInvitation", { token }), {
      token: { in: tokenCandidates("invitation", token) },
    });
    assert.deepEqual(rewriteWhere(key, "TeamInvitation", { token: stored }), {
      token: { in: [stored] },
    });
    assert.deepEqual(
      rewriteWhere(key, "SignatureDocument", {
        recipients: { some: { signingToken: { in: ["a", stored] } } },
      }),
      {
        recipients: {
          some: {
            signingToken: { in: [...tokenCandidates("signing", "a"), stored] },
          },
        },
      },
    );
    assert.deepEqual(
      uniqueVariants(key, "ReverseShare", { token: "rs" }, false),
      [...tokenCandidates("reverseShare", "rs")]
        .reverse()
        .map((value) => ({ token: value })),
    );
  }),
);

testCase(
  "without full or decrypt mode nothing is converted",
  withKey(undefined, async () => {
    const rows = {
      user: [{ id: "user-1", email, username: "x", emailFold: null }],
    };
    await convertSealedColumns(storeOf(rows), key, quiet);
    assert.equal(rows.user[0].email, email);
  }),
);

void run();
