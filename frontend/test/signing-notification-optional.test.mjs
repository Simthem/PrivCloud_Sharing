import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(
  new URL("../src/services/signing.service.ts", import.meta.url),
  "utf8",
);

test("a team signature request does not depend on X25519 support", () => {
  const body = source.slice(
    source.indexOf("const prepareTeamSigningNotifications"),
    source.indexOf("const getMyDocuments"),
  );
  const guard = body.indexOf(
    "if (!(await isX25519Supported())) return request;",
  );
  assert.ok(guard > 0, "the notification step returns the request unchanged");
  assert.ok(guard < body.indexOf("teamService.getTeam"), "before any lookup");
  assert.ok(guard < body.indexOf("encryptNotificationMetadata"));
});
