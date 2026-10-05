import assert from "node:assert/strict";
import { test } from "node:test";
import {
  hasSettledUpload,
  finalizeUpload,
} from "../src/utils/uploadCompletion.util.ts";

test("byte progress never finalizes while workers or retries remain active", () => {
  assert.equal(hasSettledUpload([{ uploadingProgress: 100 }], false), false);
  assert.equal(
    hasSettledUpload(
      [{ uploadingProgress: 100 }, { uploadingProgress: -1 }],
      false,
    ),
    false,
  );
  assert.equal(hasSettledUpload([{ uploadingProgress: 99 }], true), false);
});
test("settled partial and all-failed uploads may ask the server to finalize stored files", () => {
  assert.equal(
    hasSettledUpload(
      [{ uploadingProgress: 100 }, { uploadingProgress: -1 }],
      true,
    ),
    true,
  );
  assert.equal(hasSettledUpload([{ uploadingProgress: -1 }], true), true);
  assert.equal(hasSettledUpload([], true), false);
});
test("retries must reach a terminal state before finalization", () => {
  const files = [{ uploadingProgress: 100 }, { uploadingProgress: 70 }];
  assert.equal(hasSettledUpload(files, true), false);
  files[1].uploadingProgress = 100;
  assert.equal(hasSettledUpload(files, true), true);
});

test("a lost final response recovers the saved share without resending files", async () => {
  let recovered = 0;
  const saved = { id: "share-1", files: [{ id: "file-1" }] };
  assert.equal(
    await finalizeUpload(
      async () => {
        throw {
          response: {
            status: 400,
            data: { message: "Share already completed" },
          },
        };
      },
      async () => {
        recovered++;
        return saved;
      },
    ),
    saved,
  );
  assert.equal(recovered, 1);
  const failure = { response: { status: 413, data: { message: "Too large" } } };
  await assert.rejects(
    () =>
      finalizeUpload(
        async () => {
          throw failure;
        },
        async () => {
          recovered++;
        },
      ),
    (e) => e === failure,
  );
  assert.equal(recovered, 1);
});

const savedShare = {
  id: "share-1",
  uploadPending: false,
  files: [{ id: "file-1" }],
};

test("a matching persisted completion is accepted without another request", async () => {
  assert.equal(
    await finalizeUpload(
      async () => savedShare,
      async () => {
        assert.fail("confirmed completion needs no recovery");
      },
      savedShare.id,
    ),
    savedShare,
  );
});

test("an HTTP 200 challenge page requires a confirmed owner view", async () => {
  assert.equal(
    await finalizeUpload(
      async () => "<html>Challenge</html>",
      async () => savedShare,
      savedShare.id,
    ),
    savedShare,
  );
  for (const unconfirmed of [
    undefined,
    {},
    { id: "share-1" },
    { id: "share-1", uploadPending: true },
    { id: "another-share", uploadPending: false },
  ]) {
    await assert.rejects(
      () =>
        finalizeUpload(
          async () => unconfirmed,
          async () => unconfirmed,
          savedShare.id,
        ),
      /UPLOAD_COMPLETION_UNCONFIRMED/,
    );
  }
});

test("a lost acknowledgement recovers only when persistence confirms completion", async () => {
  for (const failure of [
    new Error("connection lost"),
    { response: { status: 408 } },
    { response: { status: 502 } },
    { response: { status: 400, data: { message: "Share already completed" } } },
  ]) {
    assert.equal(
      await finalizeUpload(
        async () => {
          throw failure;
        },
        async () => savedShare,
        savedShare.id,
      ),
      savedShare,
    );
    await assert.rejects(
      () =>
        finalizeUpload(
          async () => {
            throw failure;
          },
          async () => ({ ...savedShare, uploadPending: true }),
          savedShare.id,
        ),
      (error) => error === failure,
    );
    await assert.rejects(
      () =>
        finalizeUpload(
          async () => {
            throw failure;
          },
          async () => {
            throw new Error("owner view unavailable");
          },
          savedShare.id,
        ),
      (error) => error === failure,
    );
  }
});

test("authorization and quota failures cannot be turned into successful finalization", async () => {
  for (const status of [403, 413]) {
    const failure = { response: { status } };
    await assert.rejects(
      () =>
        finalizeUpload(
          async () => {
            throw failure;
          },
          async () => {
            assert.fail("rejected completion must not recover");
          },
          savedShare.id,
        ),
      (error) => error === failure,
    );
  }
});
