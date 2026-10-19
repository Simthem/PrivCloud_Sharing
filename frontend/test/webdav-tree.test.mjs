import assert from "node:assert/strict";
import test from "node:test";
import { collectWebDavFiles } from "../src/utils/webDavTree.util.ts";
import {
  attachUploadRelativePath,
  getSafeZipEntryName,
} from "../src/utils/uploadPath.util.ts";

const root = "https://webdav.example.test/dav/";
const entry = (path, isDirectory = false, size = 3) => ({
  id: path,
  href: new URL(path, root).href,
  name: path.replace(/\/$/, "").split("/").at(-1),
  isDirectory,
  size,
});
const collect = (selected, listing = {}, extra = {}) =>
  collectWebDavFiles({
    currentUrl: root,
    selected,
    maxBytes: 1000,
    listDirectory: async (url) => ({ url, entries: listing[url] || [] }),
    ...extra,
  });

test("WebDAV folder import preserves nested and Unicode paths and duplicate basenames", async () => {
  const folder = entry("Dossier%20%C3%A9t%C3%A9/", true);
  const nested = entry("Dossier%20%C3%A9t%C3%A9/sous/", true);
  const calls = [];
  const listings = {
    [folder.href]: [entry("Dossier%20%C3%A9t%C3%A9/rapport.txt"), nested],
    [nested.href]: [entry("Dossier%20%C3%A9t%C3%A9/sous/rapport.txt")],
  };
  const files = await collect([folder, entry("simple.txt")], listings, {
    listDirectory: async (url) => {
      calls.push(url);
      return { url, entries: listings[url] };
    },
  });
  assert.deepEqual(calls, [folder.href, nested.href]);
  assert.deepEqual(
    files.map((f) => [f.name, f.uploadRelativePath]),
    [
      ["rapport.txt", "Dossier été/rapport.txt"],
      ["rapport.txt", "Dossier été/sous/rapport.txt"],
      ["simple.txt", undefined],
    ],
  );
  // The actual metadata/ZIP path helpers consume the same property used by uploads.
  assert.deepEqual(
    files.map((f) =>
      getSafeZipEntryName(
        attachUploadRelativePath({ name: f.name }, f.uploadRelativePath),
      ),
    ),
    ["Dossier été/rapport.txt", "Dossier été/sous/rapport.txt", "simple.txt"],
  );
});

test("overlapping selections do not import the same resource twice", async () => {
  const f = entry("x/​file.txt");
  const dir = entry("x/", true);
  const files = await collect([dir, dir], { [dir.href]: [f, f] });
  assert.equal(files.length, 1);
});

test("folder quota and file count are checked before file bytes are downloaded", async () => {
  const dir = entry("x/", true);
  const listings = {
    [dir.href]: [entry("x/a.txt", false, 600), entry("x/b.txt", false, 600)],
  };
  await assert.rejects(collect([dir], listings), /webdav.error.quota/);
  await assert.rejects(
    collect([dir], listings, { maxBytes: 2000, maxFiles: 1 }),
    /webdav.error.treeLimit/,
  );
  await assert.rejects(
    collect([entry("a", false, -1)]),
    /webdav.error.unsafeTree/,
  );
  await assert.rejects(
    collect([entry("a", false, Number.MAX_SAFE_INTEGER + 1)]),
    /webdav.error.unsafeTree/,
  );
});

test("malicious listings cannot follow another origin, parent path or encoded separator", async () => {
  const dir = entry("x/", true);
  for (const href of [
    "https://other.example.test/x/a",
    root + "a",
    root + "x/a%2Fb",
    root + "x/%2E%2E",
    root + "x/a%5Cb",
    root + "x/a?token=foo",
    root + "x/grandchild/a",
  ]) {
    await assert.rejects(
      collect([dir], { [dir.href]: [{ ...entry("x/a"), href }] }),
      /webdav.error.unsafeTree/,
      href,
    );
  }
  await assert.rejects(
    collect(
      [dir],
      {},
      {
        listDirectory: async () => ({
          url: "https://other.example.test/x/",
          entries: [],
        }),
      },
    ),
    /webdav.error.unsafeTree/,
  );
});

test("cancellation stops enumeration without returning a partial import", async () => {
  const dir = entry("x/", true),
    controller = new AbortController();
  let calls = 0;
  await assert.rejects(
    collect(
      [dir],
      {},
      {
        signal: controller.signal,
        listDirectory: async (url) => {
          calls++;
          controller.abort();
          return { url, entries: [entry("x/y/", true)] };
        },
      },
    ),
    { name: "AbortError" },
  );
  assert.equal(calls, 1);
});

test("an entirely empty folder gives an explicit message and depth is bounded", async () => {
  await assert.rejects(
    collect([entry("x/", true)]),
    /webdav.error.emptyFolder/,
  );
  await assert.rejects(
    collect(
      [entry("x/", true)],
      {},
      {
        listDirectory: async (url) => ({
          url,
          entries: [{ ...entry("unused", true), href: url + "x/" }],
        }),
      },
    ),
    /webdav.error.treeLimit/,
  );
});

test("WebDAV tree paths survive encrypted metadata and reject a different share key", async () => {
  const { encryptFileMetadata, decryptFileMetadata } =
    await import("../src/utils/fileMetadata.util.ts");
  const { generateEncryptionKey } = await import("../src/utils/crypto.util.ts");
  const dir = entry("Private/", true);
  const [file] = await collect([dir], {
    [dir.href]: [entry("Private/file.txt")],
  });
  const key = await generateEncryptionKey();
  const cipher = await encryptFileMetadata(
    key,
    "public-test-share",
    "public-test-file",
    file.name,
    file.uploadRelativePath,
  );
  assert.ok(
    !Buffer.from(cipher, "base64url").includes(
      Buffer.from(file.uploadRelativePath),
    ),
  );
  assert.deepEqual(
    await decryptFileMetadata(
      key,
      "public-test-share",
      "public-test-file",
      cipher,
    ),
    { name: file.name, relativePath: "Private/file.txt" },
  );
  await assert.rejects(
    decryptFileMetadata(
      await generateEncryptionKey(),
      "public-test-share",
      "public-test-file",
      cipher,
    ),
  );
});

test("paths too large for encrypted UTF-8 metadata are rejected without flattening the tree", async () => {
  const segments = Array(9).fill("é".repeat(250));
  const dir = entry(encodeURIComponent(segments[0]) + "/", true);
  await assert.rejects(
    collect(
      [dir],
      {},
      {
        listDirectory: async (url) => {
          const level =
            new URL(url).pathname.split("/").filter(Boolean).length - 1;
          const isDirectory = level < segments.length;
          return {
            url,
            entries: [
              {
                ...entry("unused", isDirectory),
                href:
                  url +
                  (isDirectory
                    ? encodeURIComponent(segments[level]) + "/"
                    : "file.txt"),
              },
            ],
          };
        },
      },
    ),
    /webdav.error.treeLimit/,
  );
});
