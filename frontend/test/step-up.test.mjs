import assert from "node:assert/strict";
import test from "node:test";
import {
  readStepUpScope,
  requestStepUp,
  setStepUpHandler,
} from "../src/utils/stepUp.util.ts";
import { isReauthenticationRefusal } from "../src/utils/authRefresh.util.ts";

const refusal = (data, status = 403) => ({ response: { status, data } });

test("reads the operation a refused request asks to confirm", () => {
  assert.equal(
    readStepUpScope(
      refusal({ error: "step_up_required", scope: "user.update:u-1" }),
    ),
    "user.update:u-1",
  );
  for (const error of [
    refusal({ error: "step_up_required", scope: "user.update:u-1" }, 401),
    refusal({ error: "email_verification_required", scope: "config.update" }),
    refusal({ error: "step_up_required" }),
    refusal({ error: "step_up_required", scope: "../../x" }),
    refusal("<html>"),
    null,
    {},
  ]) {
    assert.equal(readStepUpScope(error), null);
  }
});

test("asks the mounted dialog, and declines without one", async () => {
  setStepUpHandler(null);
  assert.equal(await requestStepUp("config.update"), false);
  const asked = [];
  setStepUpHandler(async (scope) => {
    asked.push(scope);
    return true;
  });
  assert.equal(await requestStepUp("config.update"), true);
  assert.deepEqual(asked, ["config.update"]);
  setStepUpHandler(null);
});

test("a refused confirmation is never replayed after a refresh", () => {
  assert.equal(isReauthenticationRefusal(403, "/auth/step-up"), true);
  assert.equal(isReauthenticationRefusal(403, "auth/step-up/passkey"), true);
  assert.equal(isReauthenticationRefusal(403, "/users/u-1"), false);
});
