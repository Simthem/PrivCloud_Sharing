import assert from "node:assert/strict";
import { test } from "node:test";
import {
  fileRequestFolderLabel,
  canUploadToFileRequest,
  isSafeFileRequestNotificationAction,
} from "../src/utils/teamFileRequest.util.ts";

test("folder choices include their ancestors and tolerate cycles and missing parents", () => {
  const parent = { id: "a", name: "Documents", parentId: null };
  const child = { id: "b", name: "Factures", parentId: "a" };
  assert.equal(
    fileRequestFolderLabel(child, [parent, child]),
    "Documents / Factures",
  );
  assert.equal(fileRequestFolderLabel(child, [child]), "Factures");
  assert.equal(
    fileRequestFolderLabel(child, [{ ...parent, parentId: "b" }, child]),
    "Documents / Factures",
  );
});

test("server request, Team and destination must agree before opening an upload", () => {
  const request = {
    teamId: "team",
    folderId: "folder",
    canRespond: true,
    status: "OPEN",
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
  };
  assert.equal(canUploadToFileRequest(request, "team", "folder"), true);
  assert.equal(canUploadToFileRequest(request, "other-team", "folder"), false);
  assert.equal(canUploadToFileRequest(request, "team", "other-folder"), false);
  for (const bad of [
    undefined,
    { ...request, canRespond: false },
    { ...request, status: "CLOSED" },
    { ...request, expiresAt: new Date(0).toISOString() },
  ]) {
    assert.equal(canUploadToFileRequest(bad, "team", "folder"), false);
  }
});

test("encrypted notification navigation only allows the authenticated Team request page", () => {
  assert.equal(
    isSafeFileRequestNotificationAction(
      "/team/123e4567-e89b-42d3-a456-426614174000?fileRequests=1",
    ),
    true,
  );
  for (const url of [
    "https://evil.test",
    "//evil.test",
    "/team/../../admin?fileRequests=1",
    "/team/123e4567-e89b-42d3-a456-426614174000?fileRequests=1&redirect=evil",
  ])
    assert.equal(isSafeFileRequestNotificationAction(url), false);
});

test("French and English cover every file request message and format plurals", async () => {
  const { createIntl } = await import("react-intl");
  const { default: fr } = await import("../src/i18n/translations/fr-FR.ts");
  const { default: en } = await import("../src/i18n/translations/en-US.ts");
  const keys = (messages) =>
    Object.keys(messages)
      .filter((key) => key.startsWith("team.fileRequest."))
      .sort();
  assert.deepEqual(keys(fr), keys(en));
  assert.ok(keys(fr).length >= 50);
  for (const [locale, messages] of [
    ["fr-FR", fr],
    ["en-US", en],
  ]) {
    const errors = [];
    const intl = createIntl({
      locale,
      messages,
      onError: (error) => errors.push(error),
    });
    for (const key of keys(messages)) {
      const result = intl.formatMessage(
        { id: key },
        {
          name: "Member",
          count: 2,
          subject: "Document",
          sender: "Member",
          folder: "Folder",
          date: "10/01/2026",
          start: 1,
          end: 25,
          total: 30,
        },
      );
      assert.notEqual(result, key);
      assert.ok(!/[;—…]/u.test(result), key);
    }
    for (const count of [0, 1, 2]) {
      const formatted = intl.formatMessage(
        { id: "team.fileRequest.files" },
        { name: "Member", count },
      );
      assert.match(formatted, new RegExp(String(count)));
      assert.match(
        formatted,
        locale === "en-US"
          ? count === 1
            ? /1 file$/
            : /files$/
          : count <= 1
            ? /fichier$/
            : /fichiers$/,
      );
    }
    assert.deepEqual(errors, []);
  }
});

test("file request views only reference messages present in both catalogues", async () => {
  const { readFileSync } = await import("node:fs");
  const { default: ts } = await import("typescript");
  const { default: fr } = await import("../src/i18n/translations/fr-FR.ts");
  const { default: en } = await import("../src/i18n/translations/en-US.ts");
  for (const file of [
    "components/team/TeamFileRequests.tsx",
    "components/team/TeamDashboardMetrics.tsx",
    "components/team/TeamEncryptionStatus.tsx",
    "components/header/TeamNotificationPanel.tsx",
    "pages/upload/index.tsx",
    "pages/notifications/open/[id].tsx",
    "services/teamFileRequest.service.ts",
  ]) {
    const source = readFileSync(
      new URL("../src/" + file, import.meta.url),
      "utf8",
    );
    for (const match of source.matchAll(
      /team\.(?:fileRequest|dashboard)\.[A-Za-z0-9.-]+/g,
    )) {
      assert.ok(fr[match[0]], match[0]);
      assert.ok(en[match[0]], match[0]);
    }
    if (file === "components/team/TeamFileRequests.tsx") {
      const ast = ts.createSourceFile(
        file,
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
      );
      const visit = (node) => {
        if (ts.isJsxText(node))
          assert.equal(
            node.text.trim(),
            "",
            "User-facing JSX text must use i18n",
          );
        if (
          ts.isJsxAttribute(node) &&
          ["label", "placeholder", "description", "title"].includes(
            node.name.text,
          )
        ) {
          assert.ok(
            !node.initializer || !ts.isStringLiteral(node.initializer),
            "User-facing attributes must use i18n",
          );
        }
        ts.forEachChild(node, visit);
      };
      visit(ast);
    }
  }
});
