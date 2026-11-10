import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import { after, afterEach, before, describe, test } from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import ts from "typescript";

const require = createRequire(import.meta.url);
const token = randomUUID();
const key = randomBytes(32).toString("base64url");
let doc,
  mobile,
  navigations,
  unwraps,
  failUnwrap,
  currentUserId = "signer";
const box = ({ children }) =>
  React.createElement(
    "div",
    null,
    typeof children === "function"
      ? children({ copied: false, copy() {} })
      : children,
  );
const button = ({
  children,
  onClick,
  loading,
  disabled,
  "aria-label": label,
}) =>
  React.createElement(
    "button",
    { onClick, disabled: disabled || loading, "aria-label": label },
    children,
  );
const component = Object.assign(
  box,
  Object.fromEntries(
    [
      "Thead",
      "Tbody",
      "Tr",
      "Th",
      "Td",
      "Item",
      "Dropdown",
      "Target",
      "Label",
      "Divider",
    ].map((name) => [name, box]),
  ),
);
const core = new Proxy(
  {},
  {
    get: (_object, name) =>
      ["Button", "ActionIcon"].includes(name) ? button : component,
  },
);
const namespace = (value) => ({ __esModule: true, ...value });
const crypto = {
  getUserKey: () => "master-key",
  importKeyFromBase64: async (value) => value,
  exportKeyToBase64: async (value) => value,
  unwrapReverseShareKey: async (wrapped, master) => {
    unwraps.push([wrapped, master]);
    if (failUnwrap) throw new Error("key unavailable");
    return key;
  },
};
let openedEnvelopes, repairCalls, keyErrors, invalidEnvelope;
const mocks = {
  "@mantine/core": core,
  "@mantine/hooks": { useMediaQuery: () => mobile },
  "@mantine/modals": { useModals: () => ({}) },
  "@tanstack/react-query": {
    useQuery: ({ queryKey }) => ({
      data:
        queryKey[0] === "signing.document"
          ? doc
          : queryKey[0] === "signing.received"
            ? [doc]
            : [],
      isLoading: false,
    }),
    useQueryClient: () => ({ invalidateQueries() {} }),
    useMutation: () => ({ mutate() {}, isPending: false }),
  },
  "next/router": {
    useRouter: () => ({
      query: { id: doc?.id ?? "document" },
      push: async (path) => navigations.push(path),
      replace() {},
    }),
  },
  "react-intl": {
    useIntl: () => ({ locale: "fr", formatMessage: ({ id }) => id }),
  },
  "react-icons/tb": new Proxy(
    {},
    { get: () => () => React.createElement("span") },
  ),
  "../../hooks/useTranslate.hook": namespace({ default: () => (id) => id }),
  "../../hooks/user.hook": namespace({
    default: () => ({ user: { id: currentUserId, plan: "TEAM" } }),
  }),
  "../../hooks/useUserKeyGeneration.hook": namespace({ default: () => 0 }),
  "../../hooks/useUserKey.hook": namespace({ default: () => "master-key" }),
  "../../utils/capabilities.util": {
    resolveCapabilities: () => ({ electronicSignature: true }),
  },
  "../../utils/runtime.util": {
    isNativePlatform: () => false,
    publicWebOrigin: () => "https://signing.example.test",
  },
  "../../utils/signingKeyEnvelope.util": {
    openSigningKey: async (envelope, context) => {
      openedEnvelopes.push([envelope, context]);
      if (invalidEnvelope) throw new Error("invalid envelope");
      return key;
    },
  },
  "../../utils/toast.util": namespace({
    default: { error: (message) => keyErrors.push(message) },
  }),
  "../../services/signing.service": namespace({
    default: {
      ensureRecipientKeyEnvelopes: async (document, key) => {
        repairCalls.push([document.id, key]);
        return { stored: 1 };
      },
    },
  }),
  "../../utils/crypto.util": crypto,
  "../../components/Meta": namespace({ default: () => null }),
};
function load(path) {
  const module = { exports: {} };
  const output = ts.transpileModule(
    fs.readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8"),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        jsx: ts.JsxEmit.ReactJSX,
        esModuleInterop: true,
      },
    },
  ).outputText;
  new Function("require", "module", "exports", output)(
    (id) => {
      if (id.endsWith(".css")) return {};
      if (id in mocks) return mocks[id];
      if (id.startsWith("../../")) return namespace({ default: {} });
      return require(id);
    },
    module,
    module.exports,
  );
  return module.exports;
}
const SigningButton = load("components/signing/SigningActionButton.tsx");
mocks["../../components/signing/SigningActionButton"] = SigningButton;
const Index = load("pages/signing/index.tsx").default;
const Detail = load("pages/signing/[id].tsx").default;
const fresh = () => ({
  id: "document",
  fileName: "contract.pdf",
  status: "PENDING",
  createdAt: new Date().toISOString(),
  isRequester: false,
  recipients: [
    { id: "own", isCurrentUser: true, role: "SIGNER", status: "PENDING" },
  ],
  signingAction: { recipientId: "own", path: `/sign/${token}` },
  auditTrail: [],
});

describe("signing actions in received requests", () => {
  let dom, previous;
  const openViews = new Set();
  afterEach(async () => {
    for (const view of [...openViews]) await view.close();
  });
  before(() => {
    dom = new JSDOM("<!doctype html><html><body></body></html>", {
      url: "https://signing.example.test",
    });
    previous = new Map(
      ["window", "document", "navigator", "IS_REACT_ACT_ENVIRONMENT"].map(
        (name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)],
      ),
    );
    for (const [name, value] of Object.entries({
      window: dom.window,
      document: dom.window.document,
      navigator: dom.window.navigator,
      IS_REACT_ACT_ENVIRONMENT: true,
    })) {
      Object.defineProperty(globalThis, name, {
        configurable: true,
        writable: true,
        value,
      });
    }
  });
  after(() => {
    dom.window.close();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  async function render(Component, props) {
    navigations = [];
    openedEnvelopes = [];
    repairCalls = [];
    keyErrors = [];
    invalidEnvelope = false;
    unwraps = [];
    failUnwrap = false;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => root.render(React.createElement(Component, props)));
    const view = {
      container,
      rerender: async () => {
        await act(async () =>
          root.render(React.createElement(Component, props)),
        );
      },
      close: async () => {
        await act(async () => root.unmount());
        container.remove();
        openViews.delete(view);
      },
    };
    openViews.add(view);
    return view;
  }
  const signButton = (view) =>
    [...view.container.querySelectorAll("button")].find(
      (node) =>
        node.textContent === "signing.sign.steps.sign" ||
        node.getAttribute("aria-label") === "signing.sign.steps.sign",
    );

  test("phone and desktop list buttons open the signing link in the current tab without opening details", async () => {
    for (mobile of [false, true]) {
      doc = fresh();
      const view = await render(Index);
      const sign = signButton(view);
      assert.ok(sign);
      await act(async () => sign.click());
      assert.deepEqual(navigations, [`/sign/${token}`]);
      assert.equal(view.container.querySelector('[target="_blank"]'), null);
      await view.close();
    }
  });
  test("the recipient detail offers signing and hides requester controls and links", async () => {
    doc = fresh();
    const view = await render(Detail);
    assert.ok(signButton(view));
    assert.doesNotMatch(
      view.container.textContent,
      /signing.actions.remind|signing.detail.cancel-request|signing.detail.signing-links/,
    );
    await act(async () => signButton(view).click());
    assert.deepEqual(navigations, [`/sign/${token}`]);
    await view.close();
  });
  test("the requester keeps reminder and cancellation controls without being offered another person's signature", async () => {
    doc = { ...fresh(), isRequester: true, signingAction: null };
    doc.recipients[0].signingToken = token;
    const view = await render(Detail);
    assert.equal(signButton(view), undefined);
    assert.match(view.container.textContent, /signing.actions.remind/);
    assert.match(view.container.textContent, /signing.detail.cancel-request/);
    assert.match(view.container.textContent, /signing.detail.signing-links/);
    await view.close();
  });
  test("both layouts and details hide signing when the server provides no action", async () => {
    for (const Component of [Index, Detail]) {
      for (mobile of [false, true]) {
        doc = { ...fresh(), signingAction: null };
        const view = await render(Component);
        assert.equal(signButton(view), undefined);
        await view.close();
      }
    }
  });
  test("the received role belongs to this account rather than the first recipient", async () => {
    for (mobile of [false, true]) {
      doc = fresh();
      doc.recipients = [{ role: "CC", status: "PENDING" }, ...doc.recipients];
      const view = await render(Index);
      assert.match(view.container.textContent, /signing.role.signer/);
      assert.doesNotMatch(view.container.textContent, /signing.role.cc/);
      await view.close();
    }
  });
  test("the account's wrapped key reaches only the URL fragment", async () => {
    const view = await render(SigningButton.default, {
      action: {
        recipientId: "own",
        path: `/sign/${token}`,
        wrappedE2EKey: "wrapped",
      },
    });
    await act(async () => signButton(view).click());
    assert.deepEqual(unwraps, [["wrapped", "master-key"]]);
    assert.deepEqual(navigations, [`/sign/${token}#key=${key}`]);
    await view.close();
  });
  test("an already resolved document key is preserved without another unwrap", async () => {
    const view = await render(SigningButton.default, {
      action: {
        recipientId: "own",
        path: `/sign/${token}`,
        wrappedE2EKey: "wrapped",
      },
      e2eKey: key,
    });
    await act(async () => signButton(view).click());
    assert.deepEqual(unwraps, []);
    assert.deepEqual(navigations, [`/sign/${token}#key=${key}`]);
    await view.close();
  });
  test("an unavailable local key still opens the existing invitation recovery screen", async () => {
    const view = await render(SigningButton.default, {
      action: {
        recipientId: "own",
        path: `/sign/${token}`,
        wrappedE2EKey: "wrapped",
      },
    });
    failUnwrap = true;
    await act(async () => signButton(view).click());
    assert.deepEqual(navigations, [`/sign/${token}`]);
    await view.close();
  });
  test("document changes never attach the previous document's key to the next invitation", async () => {
    doc = { ...fresh(), isE2EEncrypted: true };
    doc.recipients[0].wrappedE2EKey = "wrapped";
    const view = await render(Detail);
    assert.equal(unwraps.length, 1);
    const nextToken = randomUUID();
    doc = {
      ...fresh(),
      id: "second-document",
      isE2EEncrypted: true,
      signingAction: { recipientId: "own", path: `/sign/${nextToken}` },
    };
    await view.rerender();
    await act(async () => signButton(view).click());
    assert.deepEqual(navigations, [`/sign/${nextToken}`]);
    await view.close();
  });
  test("account changes cannot reuse the previous account's resolved key", async () => {
    doc = { ...fresh(), isE2EEncrypted: true };
    doc.recipients[0].wrappedE2EKey = "wrapped";
    const view = await render(Detail);
    assert.equal(unwraps.length, 1);
    currentUserId = "second-account";
    doc = { ...fresh(), isE2EEncrypted: true };
    await view.rerender();
    await act(async () => signButton(view).click());
    assert.deepEqual(navigations, [`/sign/${token}`]);
    await view.close();
    currentUserId = "signer";
  });
  test("both received layouts open a fresh encrypted invitation without a prior link visit", async () => {
    for (mobile of [false, true]) {
      doc = { ...fresh(), isE2EEncrypted: true };
      doc.signingAction = {
        ...doc.signingAction,
        isE2EEncrypted: true,
        keyEnvelope: {
          ciphertext: "encrypted-invitation",
          documentId: doc.id,
          fileId: "source",
          recipientUserId: "signer",
        },
      };
      const view = await render(Index);
      await act(async () => signButton(view).click());
      assert.deepEqual(navigations, [`/sign/${token}#key=${key}`]);
      assert.deepEqual(openedEnvelopes, [
        [
          "encrypted-invitation",
          { documentId: doc.id, fileId: "source", recipientUserId: "signer" },
        ],
      ]);
      assert.deepEqual(unwraps, []);
      await view.close();
    }
  });
  test("the detail page recovers the recipient envelope before opening the signer", async () => {
    doc = { ...fresh(), isE2EEncrypted: true, fileId: "source" };
    doc.recipients[0].encryptedKeyEnvelope = "encrypted-invitation";
    doc.signingAction.isE2EEncrypted = true;
    const view = await render(Detail);
    await act(async () => signButton(view).click());
    assert.deepEqual(navigations, [`/sign/${token}#key=${key}`]);
    assert.equal(openedEnvelopes.length, 1);
    await view.close();
  });
  test("an archived signed result keeps its recipient key after source deletion", async () => {
    doc = {
      ...fresh(),
      isE2EEncrypted: true,
      fileId: null,
      fileDeleted: true,
      status: "COMPLETED",
      signingAction: null,
    };
    doc.recipients[0].status = "SIGNED";
    doc.recipients[0].encryptedKeyEnvelope = "encrypted-invitation";
    const view = await render(Detail);
    assert.deepEqual(openedEnvelopes, [
      [
        "encrypted-invitation",
        { documentId: doc.id, fileId: null, recipientUserId: "signer" },
      ],
    ]);
    assert.doesNotMatch(
      view.container.textContent,
      /signing.detail.download.e2e-open-link/,
    );
    await view.close();
  });
  test("a key kept from the original link in this tab still opens an older invitation", async () => {
    const view = await render(SigningButton.default, {
      action: {
        recipientId: "own",
        path: `/sign/${token}`,
        isE2EEncrypted: true,
      },
    });
    const kept = `signing.link-key:${token}`;
    window.sessionStorage.setItem(kept, key);
    try {
      await act(async () => signButton(view).click());
      assert.deepEqual(navigations, [`/sign/${token}#key=${key}`]);
    } finally {
      window.sessionStorage.removeItem(kept);
      await view.close();
    }
  });
  test("a missing or corrupted encrypted key never opens an unusable signer", async () => {
    for (const corrupted of [false, true]) {
      const action = {
        recipientId: "own",
        path: `/sign/${token}`,
        isE2EEncrypted: true,
        ...(corrupted
          ? {
              keyEnvelope: {
                ciphertext: "tampered",
                documentId: "document",
                fileId: "source",
                recipientUserId: "signer",
              },
            }
          : {}),
      };
      const view = await render(SigningButton.default, { action });
      invalidEnvelope = corrupted;
      await act(async () => signButton(view).click());
      assert.deepEqual(navigations, []);
      assert.deepEqual(keyErrors, ["signing.key.unavailable"]);
      assert.equal(signButton(view).disabled, false);
      await view.close();
    }
  });
  test("the requester automatically prepares missing recipient envelopes after resolving its key", async () => {
    doc = {
      ...fresh(),
      isRequester: true,
      isE2EEncrypted: true,
      fileId: "source",
    };
    doc.recipients[0].wrappedE2EKey = "wrapped";
    const view = await render(Detail);
    assert.deepEqual(repairCalls, [[doc.id, key]]);
    await view.rerender();
    assert.equal(repairCalls.length, 1);
    await view.close();
  });
  test("rejects destinations outside the signing route", async () => {
    for (const path of [
      "https://outside.example",
      "//outside.example",
      "/sign/token?redirect=outside",
      "/sign/token#key=outside",
      "javascript:alert(1)",
    ]) {
      const view = await render(SigningButton.default, {
        action: { recipientId: "own", path },
      });
      assert.equal(signButton(view), undefined);
      assert.deepEqual(navigations, []);
      await view.close();
    }
  });
});
