import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import { after, before, describe, test } from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import ts from "typescript";

const require = createRequire(import.meta.url);
let currentUser, updates, refreshes, messages, update, serverUser;
const module = { exports: {} };
const output = ts.transpileModule(
  fs.readFileSync(
    new URL(
      "../src/components/account/SignaturePushPreference.tsx",
      import.meta.url,
    ),
    "utf8",
  ),
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
  },
).outputText;
const box = ({ children }) => React.createElement("div", null, children);
const mocks = {
  "@mantine/core/styles/Switch.css": {},
  "./NotificationSettings.module.css": { default: {} },
  "react-icons/tb": { TbWritingSign: box },
  "@mantine/core": {
    Group: box,
    Box: box,
    Paper: box,
    Text: box,
    Title: box,
    Switch: ({ label, ...props }) =>
      React.createElement("input", {
        ...props,
        type: "checkbox",
        "aria-label": label,
      }),
  },
  "../../hooks/user.hook": {
    default: () => ({
      user: currentUser,
      refreshUser: async () => {
        refreshes++;
      },
    }),
  },
  "../../hooks/useTranslate.hook": { default: () => (id) => id },
  "../../services/user.service": {
    default: {
      updateCurrentUser: (...args) => update(...args),
      getCurrentUserStrict: async () => serverUser ?? currentUser,
    },
  },
  "../../utils/toast.util": {
    default: {
      success: (text) => messages.push(["success", text]),
      error: (text) => messages.push(["error", text]),
    },
  },
};
for (const key of Object.keys(mocks)) mocks[key].__esModule = true;
new Function("require", "module", "exports", output)(
  (id) => mocks[id] ?? require(id),
  module,
  module.exports,
);
const Preference = module.exports.default;

describe("signature push preference", () => {
  let dom, previous;
  before(() => {
    dom = new JSDOM("<!doctype html><html><body></body></html>", {
      url: "https://account.example.test",
    });
    previous = new Map(
      ["window", "document", "navigator", "IS_REACT_ACT_ENVIRONMENT"].map(
        (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)],
      ),
    );
    for (const [key, value] of Object.entries({
      window: dom.window,
      document: dom.window.document,
      navigator: dom.window.navigator,
      IS_REACT_ACT_ENVIRONMENT: true,
    }))
      Object.defineProperty(globalThis, key, {
        configurable: true,
        value,
        writable: true,
      });
  });
  after(() => {
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  const render = async (user, server) => {
    currentUser = user;
    serverUser = server;
    updates = [];
    refreshes = 0;
    messages = [];
    update = async (payload) => {
      updates.push(payload);
      return { signaturePushEnabled: payload.signaturePushEnabled };
    };
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => root.render(React.createElement(Preference)));
    return {
      container,
      close: async () => {
        await act(async () => root.unmount());
        container.remove();
      },
    };
  };
  test("hides the setting until the server confirms active team eligibility", async () => {
    for (const user of [
      null,
      { signaturePushEligible: false },
      { isAdmin: true, signaturePushEligible: false },
    ]) {
      const view = await render(user);
      assert.equal(view.container.textContent, "");
      assert.equal(view.container.querySelector("input"), null);
      await view.close();
    }
  });
  test("saves an explicit opt-in, disables repeated clicks and refreshes the account", async () => {
    const view = await render({
      signaturePushEligible: true,
      signaturePushEnabled: false,
    });
    let complete;
    update = (payload) => {
      updates.push(payload);
      return new Promise((resolve) => {
        complete = resolve;
      });
    };
    const input = view.container.querySelector("input");
    assert.equal(input.checked, false);
    await act(async () => input.click());
    assert.deepEqual(updates, [{ signaturePushEnabled: true }]);
    assert.equal(input.disabled, true);
    await act(async () => complete({ signaturePushEnabled: true }));
    assert.equal(refreshes, 1);
    assert.equal(input.disabled, false);
    assert.deepEqual(messages, [["success", "common.success"]]);
    await view.close();
  });
  test("keeps the saved preference and re-enables the switch if saving fails", async () => {
    const view = await render({
      signaturePushEligible: true,
      signaturePushEnabled: true,
    });
    update = async () => {
      throw new Error("unavailable");
    };
    const input = view.container.querySelector("input");
    await act(async () => input.click());
    assert.equal(input.checked, true);
    assert.equal(input.disabled, false);
    assert.equal(refreshes, 0);
    assert.deepEqual(messages, [["error", "common.error"]]);
    await view.close();
  });
  test("loads the server preference when the session omitted eligibility", async () => {
    const view = await render(
      { id: "member", hasTeamMembership: true },
      {
        id: "member",
        signaturePushEligible: true,
        signaturePushEnabled: false,
      },
    );
    const input = view.container.querySelector("input");
    assert.ok(input);
    assert.equal(input.disabled, false);
    await act(async () => input.click());
    assert.equal(input.checked, true);
    assert.deepEqual(updates, [{ signaturePushEnabled: true }]);
    assert.deepEqual(messages, [["success", "common.success"]]);
    await view.close();
  });
  test("shows an unavailable setting without granting eligibility when the server field is absent", async () => {
    const view = await render({ id: "member", hasTeamMembership: true });
    assert.equal(view.container.querySelector("input").disabled, true);
    assert.match(
      view.container.textContent,
      /account.notify.signature.unavailable/,
    );
    await view.close();
  });
  test("does not report success when an older API ignored the preference", async () => {
    const view = await render({
      signaturePushEligible: true,
      signaturePushEnabled: false,
    });
    update = async (payload) => {
      updates.push(payload);
      return {};
    };
    await act(async () => view.container.querySelector("input").click());
    assert.deepEqual(messages, [["error", "common.error"]]);
    await view.close();
  });
  test("shows the confirmed option for a account who has no team", async () => {
    const view = await render(
      { id: "subscriber", hasTeamMembership: false },
      {
        id: "subscriber",
        signaturePushEligible: true,
        signaturePushEnabled: false,
      },
    );
    const input = view.container.querySelector("input");
    assert.ok(input);
    assert.equal(input.disabled, false);
    await act(async () => input.click());
    assert.equal(input.checked, true);
    assert.deepEqual(updates, [{ signaturePushEnabled: true }]);
    await view.close();
  });
});
