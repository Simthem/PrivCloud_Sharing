import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import { QueryClient } from "@tanstack/react-query";
import {
  synchronizeCompletedUpload,
  synchronizeRemovedShare,
} from "../src/utils/uploadStateCache.util.ts";
import ts from "typescript";
import { finalizeUpload } from "../src/utils/uploadCompletion.util.ts";

const source = readFileSync(
  new URL("../src/components/upload/EditableUpload.tsx", import.meta.url),
  "utf8",
);
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    jsx: ts.JsxEmit.ReactJSX,
    esModuleInterop: true,
  },
}).outputText;

// Run the production component's handlers with deferred React state updates.
// Network, crypto and native service dependencies remain outside this test.
function fixture({ savedFiles = [], uploadPending = true } = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { gcTime: 0 } },
  });
  queryClient.setQueryData(
    ["pendingUploads", "owner"],
    [{ id: "share" }, { id: "another" }],
  );
  queryClient.setQueryData(["myShares", "owner"], []);
  const states = [],
    refs = [],
    queued = [],
    attempts = [],
    deletions = [],
    fileRemovals = [];
  let stateIndex = 0,
    refIndex = 0,
    active = false,
    completions = 0;
  let uploadFails = () => false,
    completeFails = false,
    deleteFails = false,
    unlocks = 0,
    backwards = 0,
    tree;
  const jsx = (type, props) => ({ type, props });
  const defaultExport = (value) => ({ __esModule: true, default: value });
  const modules = {
    "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
    react: {
      useEffect: () => {},
      useMemo: (fn) => fn(),
      useRef: (value) => (refs[refIndex++] ??= { current: value }),
      useState: (value) => {
        const index = stateIndex++;
        if (!(index in states)) states[index] = value;
        return [
          states[index],
          (update) =>
            queued.push(() => {
              states[index] =
                typeof update === "function" ? update(states[index]) : update;
            }),
        ];
      },
    },
    "@mantine/core": {
      Alert: "Alert",
      Button: "Button",
      Group: "Group",
      Text: "Text",
    },
    "@mantine/modals": { useModals: () => ({}) },
    "@mantine/notifications": { cleanNotifications: () => {} },
    "next/router": {
      useRouter: () => ({
        back: () => {
          backwards++;
        },
      }),
    },
    "p-limit": defaultExport(() => (fn) => fn()),
    "react-intl": { FormattedMessage: "FormattedMessage" },
    "@tanstack/react-query": {
      useQuery: () => ({ data: 1_000_000 }),
      useQueryClient: () => queryClient,
    },
    Dropzone: defaultExport("Dropzone"),
    FileList: defaultExport("FileList"),
    "config.hook": defaultExport(() => ({ get: () => "1000000" })),
    "useTranslate.hook": defaultExport(() => (id) => id),
    "user.hook": defaultExport(() => ({ user: { id: "owner" } })),
    "useWakeLock.hook": defaultExport(() => ({
      acquire: async () => {},
      release: () => {},
    })),
    "confirm-leave.hook": defaultExport(() => {}),
    "config.service": defaultExport({
      getRuntimeUploadMaxChunkSize: async () => 1_000_000,
    }),
    "stripe.service": defaultExport({ getUploadLimit: async () => 1_000_000 }),
    "share.service": defaultExport({
      revertComplete: async () => {
        unlocks++;
      },
      remove: async (id, discard) => {
        deletions.push({ id, discard });
        if (deleteFails) throw new Error("Delete failed");
      },
      removeFile: async (share, id) => {
        fileRemovals.push(id);
      },
      keepUploadAlive: async () => {},
      completeShare: async () => {
        completions++;
        if (completeFails) throw new Error("WAF unavailable");
        return { id: "share", uploadPending: false };
      },
    }),
    "api.service": {
      isUploadActive: () => active,
      setUploadActive: (value) => (active = value),
      completeSafeLineChallenge: async () => {},
    },
    "uploadSessionMaintenance.util": {
      startUploadSessionMaintenance: () => () => {},
    },
    "uploadCompletion.util": { finalizeUpload },
    "uploadStateCache.util": {
      synchronizeCompletedUpload,
      synchronizeRemovedShare,
    },
    "safelineChallenge.util": { prepareSafeLineRetry: async () => {} },
    "uploadResume.util": {
      readUploadResumeEntries: async () => [],
      matchUploadResumeEntry: async () => undefined,
    },
    "upload.util": {
      prewarmUploadBandwidth: () => {},
      measureBandwidthForUpload: async () => 1,
      getAdaptiveChunkSize: async () => 1000,
      uploadFileViaWorker: async (
        file,
        _share,
        _chunk,
        _e2e,
        _key,
        progress,
      ) => {
        attempts.push(file.name);
        progress(0, 1, "file", file.size);
        if (uploadFails(file)) throw new Error("Transfer failed");
      },
    },
    "uploadPerformance.util": {
      clampUploadChunkSizeLimit: () => 1_000_000,
      getUploadChunkSizeLimit: () => 1_000_000,
      getUploadChunkProfile: () => ({}),
      getRuntimeUploadChunkConfigKey: () => "fixture",
      getUploadSchedulingProfile: () => ({
        mode: "fixture",
        fileConcurrency: 2,
        maxParallelLanes: 2,
      }),
      getNativeUploadChunkSize: () => 1000,
      E2E_CRYPTO_RECORD_SIZE: 1_000_000,
    },
    "fileMetadata.util": { isFileMetaShare: () => false },
    "crypto.util": { getUserKey: () => "fixture" },
    "shareKey.util": { SHARE_DEK_V1: 1 },
    "shareCryptoEvents.util": { reportShareCryptoEvent: () => {} },
    "toast.util": defaultExport({ error: () => {}, success: () => {} }),
    backgroundTransfer: {},
    nativeAuthStore: {
      getAccessTokenSync: () => "",
      getRefreshTokenSync: () => "",
    },
    "runtime.util": {
      isNativePlatform: () => false,
      API_ORIGIN: "https://fixture.test",
    },
    nativeUpload: {
      isNativeUploadFile: (file) => !!file.privcloudNativeSource,
      enqueueNativeUpload: async () => false,
    },
  };
  const exports = {};
  vm.runInNewContext(compiled, {
    exports,
    crypto: globalThis.crypto,
    AbortController,
    console: { info: () => {} },
    require: (name) => {
      const id = name.split("/").at(-1);
      const found = modules[name] ?? modules[id];
      if (!found) throw new Error("Missing fixture dependency " + name);
      return found;
    },
  });
  const render = () => {
    while (queued.length) queued.shift()();
    stateIndex = refIndex = 0;
    tree = exports.default({
      shareId: "share",
      files: savedFiles,
      uploadPending,
    });
  };
  function find(type, node = tree) {
    if (Array.isArray(node))
      return node.map((item) => find(type, item)).find(Boolean);
    if (!node || typeof node !== "object") return undefined;
    if (node.type === type) return node;
    return find(type, node.props?.children ?? null);
  }
  render();
  return {
    attempts,
    deletions,
    fileRemovals,
    get unlocks() {
      return unlocks;
    },
    get backwards() {
      return backwards;
    },
    queryClient,
    get completions() {
      return completions;
    },
    get active() {
      return active;
    },
    get files() {
      return find("FileList").props.files;
    },
    failUploads: (fn) => (uploadFails = fn),
    failCompletion: (value) => (completeFails = value),
    failDeletion: (value) => (deleteFails = value),
    removeAll: () => {
      find("FileList").props.setFiles(
        find("FileList").props.files.map((file) => ({
          ...file,
          deleted: true,
        })),
      );
      render();
    },
    append: async (files) => {
      await find("Dropzone").props.onFilesChanged(files);
      render();
    },
    save: async () => {
      await find("Button").props.onClick();
      render();
    },
  };
}
const file = (name) =>
  Object.assign(new File(["content"], name), { uploadingProgress: 0 });

test("a failed worker keeps finalization pending even before React applies progress", async () => {
  const upload = fixture();
  upload.failUploads((item) => item.name === "second.bin");
  await upload.append([file("first.bin"), file("second.bin")]);
  await upload.save();
  assert.equal(upload.completions, 0);
  assert.equal(upload.active, true);
  assert.deepEqual(
    Array.from(upload.files, (item) => item.uploadingProgress),
    [100, -1],
  );
  upload.failUploads(() => false);
  await upload.save();
  assert.deepEqual(upload.attempts, ["first.bin", "second.bin", "second.bin"]);
  assert.deepEqual(
    Array.from(upload.files, (item) => item.uploadingProgress),
    [100, 100],
  );
  assert.equal(upload.completions, 1);
  assert.equal(upload.active, false);
  assert.deepEqual(
    upload.queryClient.getQueryData(["pendingUploads", "owner"]),
    [{ id: "another" }],
  );
  assert.equal(
    upload.queryClient.getQueryState(["myShares", "owner"]).isInvalidated,
    true,
  );
  upload.queryClient.clear();
});

test("finalization recovery does not resend files after a WAF failure", async () => {
  const upload = fixture();
  upload.failCompletion(true);
  await upload.append([file("first.bin")]);
  await upload.save();
  assert.equal(upload.active, true);
  assert.deepEqual(
    upload.queryClient.getQueryData(["pendingUploads", "owner"]),
    [{ id: "share" }, { id: "another" }],
  );
  assert.equal(upload.completions, 1);
  upload.failCompletion(false);
  await upload.save();
  assert.deepEqual(upload.attempts, ["first.bin"]);
  assert.equal(upload.completions, 2);
  assert.equal(upload.active, false);
  assert.deepEqual(
    upload.queryClient.getQueryData(["pendingUploads", "owner"]),
    [{ id: "another" }],
  );
  assert.equal(
    upload.queryClient.getQueryState(["myShares", "owner"]).isInvalidated,
    true,
  );
  upload.queryClient.clear();
});

if (source.includes("enqueueNativeFiles"))
  test("a refused native handoff cannot finalize an incomplete upload", async () => {
    const upload = fixture();
    await upload.append([
      Object.assign(file("native.bin"), {
        privcloudNativeSource: { uri: "content://fixture" },
      }),
    ]);
    await upload.save();
    assert.equal(upload.completions, 0);
    assert.equal(upload.active, true);
    assert.deepEqual(upload.attempts, []);
    upload.queryClient.clear();
  });

test("saving an edit with every file removed deletes the share without unlocking or finalizing it", async () => {
  const upload = fixture({
    savedFiles: [{ id: "old", name: "old.bin", size: "7" }],
    uploadPending: false,
  });
  upload.removeAll();
  await upload.save();
  assert.deepEqual(upload.deletions, [{ id: "share", discard: true }]);
  assert.equal(upload.unlocks, 0);
  assert.equal(upload.completions, 0);
  assert.deepEqual(upload.fileRemovals, []);
  assert.equal(upload.active, false);
  assert.equal(upload.backwards, 1);
  assert.deepEqual(
    upload.queryClient.getQueryData(["pendingUploads", "owner"]),
    [{ id: "another" }],
  );
  upload.queryClient.clear();
});

test("a failed whole-share deletion preserves its published state and can be retried", async () => {
  const upload = fixture({
    savedFiles: [{ id: "old", name: "old.bin", size: "7" }],
    uploadPending: false,
  });
  upload.removeAll();
  upload.failDeletion(true);
  await upload.save();
  assert.equal(upload.unlocks, 0);
  assert.equal(upload.completions, 0);
  assert.equal(upload.backwards, 0);
  assert.deepEqual(
    upload.queryClient.getQueryData(["pendingUploads", "owner"]),
    [{ id: "share" }, { id: "another" }],
  );
  upload.failDeletion(false);
  await upload.save();
  assert.equal(upload.deletions.length, 2);
  assert.equal(upload.backwards, 1);
  upload.queryClient.clear();
});

test("removing old files while adding a replacement never triggers whole-share deletion", async () => {
  const upload = fixture({
    savedFiles: [{ id: "old", name: "old.bin", size: "7" }],
  });
  upload.removeAll();
  upload.failUploads(() => true);
  await upload.append([file("replacement.bin")]);
  await upload.save();
  assert.deepEqual(upload.deletions, []);
  assert.deepEqual(
    upload.fileRemovals,
    [],
    "failed uploads preserve existing files",
  );
  assert.equal(upload.completions, 0);
  upload.queryClient.clear();
});
