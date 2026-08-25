import assert from "node:assert/strict";
import test from "node:test";

import { shouldPromptForE2EKey } from "../src/utils/e2ePromptPolicy.util.ts";

test("an explicit E2E opt-out wins over team membership", () => {
  assert.equal(
    shouldPromptForE2EKey(
      {
        hasEncryptionKey: false,
        hasTeamMembership: true,
        e2eAutoGenerationDisabled: true,
      },
      false,
    ),
    false,
  );
});

test("an explicit E2E opt-out also wins over a stale server-key flag", () => {
  assert.equal(
    shouldPromptForE2EKey(
      {
        hasEncryptionKey: true,
        hasTeamMembership: true,
        e2eAutoGenerationDisabled: true,
      },
      false,
    ),
    false,
  );
});

test("a missing local copy of an existing server key requests recovery", () => {
  assert.equal(
    shouldPromptForE2EKey(
      { hasEncryptionKey: true, e2eAutoGenerationDisabled: false },
      false,
    ),
    true,
  );
});

test("a team member who never opted out is offered E2E setup", () => {
  assert.equal(
    shouldPromptForE2EKey(
      {
        hasEncryptionKey: false,
        hasTeamMembership: true,
        e2eAutoGenerationDisabled: false,
      },
      false,
    ),
    true,
  );
});

test("an already loaded local key never opens the prompt", () => {
  assert.equal(
    shouldPromptForE2EKey(
      { hasEncryptionKey: true, hasTeamMembership: true },
      true,
    ),
    false,
  );
});

test("an account without an E2E context is left alone", () => {
  assert.equal(
    shouldPromptForE2EKey(
      { hasEncryptionKey: false, hasTeamMembership: false },
      false,
    ),
    false,
  );
});
