import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import { after, before, describe, test } from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import ts from "typescript";

const require = createRequire(import.meta.url);
let permission, subscription, failSave, calls;
const box = ({ children }) => React.createElement("div", null, children);
const mocks = {
  "./NotificationSettings.module.css": { default: {} },
  "./NotificationSettings.module.css": { default: {} },
  "@mantine/core": {
    Paper: box,
    Group: box,
    Stack: box,
    Text: box,
    Title: box,
    Divider: box,
    Button: ({ children, onClick, disabled }) =>
      React.createElement("button", { onClick, disabled }, children),
    Collapse: ({ children, in: opened }) =>
      React.createElement(
        "div",
        { "data-preferences": true, hidden: !opened },
        children,
      ),
  },
  "react-icons/tb": { TbBell: box, TbBellOff: box },
  "../../hooks/config.hook": {
    default: () => ({ getBoolean: () => true, getString: () => "AQID" }),
  },
  "../../hooks/useTranslate.hook": { default: () => (id) => id },
  "../../utils/runtime.util": { isNativePlatform: () => false },
  "../../utils/toast.util": { default: { success: () => {}, error: () => {} } },
  "../../services/api.service": {
    default: {
      post: async (url) => {
        calls.push(["post", url]);
        if (failSave) throw new Error("unavailable");
      },
      delete: async (url) => calls.push(["delete", url]),
    },
  },
};
for (const mock of Object.values(mocks)) mock.__esModule = true;
const mod = { exports: {} };
const source = ts.transpileModule(
  fs.readFileSync(
    new URL(
      "../src/components/account/PushNotificationSection.tsx",
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
new Function("require", "module", "exports", source)(
  (id) => mocks[id] ?? require(id),
  mod,
  mod.exports,
);
const Section = mod.exports.default;
describe("account push settings", () => {
  let dom, previous;
  before(() => {
    dom = new JSDOM("<!doctype html><html><body></body></html>", {
      url: "https://account.example.test",
    });
    const notification = {
      get permission() {
        return permission;
      },
      requestPermission: async () => permission,
    };
    Object.assign(dom.window, {
      PushManager: class {},
      Notification: notification,
    });
    Object.defineProperty(dom.window.navigator, "serviceWorker", {
      value: {
        ready: Promise.resolve({
          pushManager: {
            getSubscription: async () => subscription,
            subscribe: async () => {
              subscription = {
                toJSON: () => ({
                  endpoint: "https://push.example.test/device",
                  keys: { p256dh: "fixture", auth: "fixture" },
                }),
                unsubscribe: async () => {
                  subscription = null;
                  return true;
                },
              };
              return subscription;
            },
          },
        }),
      },
    });
    const globals = {
      window: dom.window,
      document: dom.window.document,
      navigator: dom.window.navigator,
      Notification: notification,
      Event: dom.window.Event,
      IS_REACT_ACT_ENVIRONMENT: true,
    };
    previous = new Map(
      Object.keys(globals).map((key) => [
        key,
        Object.getOwnPropertyDescriptor(globalThis, key),
      ]),
    );
    for (const [key, value] of Object.entries(globals))
      Object.defineProperty(globalThis, key, {
        configurable: true,
        writable: true,
        value,
      });
  });
  after(() => {
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  async function render() {
    permission = "granted";
    subscription = null;
    failSave = false;
    calls = [];
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () =>
      root.render(
        React.createElement(
          Section,
          null,
          React.createElement("input", {
            type: "checkbox",
            defaultChecked: true,
          }),
        ),
      ),
    );
    return {
      container,
      close: async () => {
        await act(async () => root.unmount());
        container.remove();
      },
    };
  }
  test("account push preferences expand after subscription and collapse on disable without resetting their values", async () => {
    const view = await render();
    const preferences = () =>
      view.container.querySelector("[data-preferences]");
    assert.equal(preferences().hidden, true);
    await act(async () => view.container.querySelector("button").click());
    assert.deepEqual(calls, [["post", "/push/subscribe"]]);
    assert.equal(preferences().hidden, false);
    assert.equal(preferences().querySelector("input").checked, true);
    await act(async () => view.container.querySelector("button").click());
    assert.deepEqual(calls[1], ["delete", "/push/subscribe"]);
    assert.equal(preferences().hidden, true);
    assert.equal(preferences().querySelector("input").checked, true);
    await view.close();
  });
  test("account push preferences stay collapsed when the subscription cannot be saved", async () => {
    const view = await render();
    failSave = true;
    await act(async () => view.container.querySelector("button").click());
    assert.equal(
      view.container.querySelector("[data-preferences]").hidden,
      true,
    );
    assert.equal(
      subscription,
      null,
      "A failed save must not leave a local subscription behind",
    );
    await view.close();
  });

  test("account push preferences follow subscription changes made elsewhere", async () => {
    const view = await render();
    subscription = {
      toJSON: () => ({ endpoint: "https://push.example.test/device" }),
    };
    await act(async () =>
      window.dispatchEvent(new window.Event("push-subscription-changed")),
    );
    assert.equal(
      view.container.querySelector("[data-preferences]").hidden,
      false,
    );
    subscription = null;
    await act(async () =>
      window.dispatchEvent(new window.Event("push-subscription-changed")),
    );
    assert.equal(
      view.container.querySelector("[data-preferences]").hidden,
      true,
    );
    await view.close();
  });
  test("dismissing the browser permission prompt leaves activation available", async () => {
    const view = await render();
    permission = "default";
    await act(async () => view.container.querySelector("button").click());
    assert.equal(view.container.querySelector("button").disabled, false);
    assert.equal(
      view.container.querySelector("[data-preferences]").hidden,
      true,
    );
    await view.close();
  });
});
