import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import { codecsOfInitSegment } from "../src/utils/mediaEngine.util.ts";
import { MEDIA_ENGINE_FILES } from "../scripts/build-video-decoders.mjs";

const fixture = (name) =>
  new Uint8Array(
    readFileSync(new URL(`fixtures/media-engine/${name}`, import.meta.url)),
  );

test("the codecs of a fragmented MP4 come from its sample entries", () => {
  assert.equal(
    codecsOfInitSegment(fixture("avc-init.mp4")),
    "avc1.64000d,mp4a.40.2",
  );
  assert.equal(
    codecsOfInitSegment(fixture("hevc-init.mp4")),
    "hvc1.1.6.L60.90,mp4a.40.2",
  );
  assert.equal(
    codecsOfInitSegment(fixture("vp9-init.mp4")),
    "vp09.00.20.08,mp4a.40.2",
  );
});

test("a truncated or foreign segment names no codec", () => {
  const init = fixture("avc-init.mp4");
  assert.equal(codecsOfInitSegment(init.subarray(0, init.length - 40)), null);
  assert.equal(codecsOfInitSegment(new Uint8Array(64)), null);
  assert.equal(codecsOfInitSegment(new Uint8Array(0)), null);
});

test("the media engine served is the reviewed LGPL build", () => {
  const recipe = readFileSync(
    new URL("../scripts/media-engine/Dockerfile", import.meta.url),
    "utf8",
  );
  // Pinned image and sources, a build without network nor GPL parts.
  assert.match(recipe, /^FROM emscripten\/emsdk:[\d.]+@sha256:[0-9a-f]{64} /m);
  assert.equal(recipe.match(/sha256sum -c -/g)?.length, 3);
  assert.match(recipe, /CONFIG_GPL 0/);
  assert.match(recipe, /CONFIG_NONFREE 0/);
  const variant = JSON.parse(
    readFileSync(
      new URL("../scripts/media-engine/variant.json", import.meta.url),
      "utf8",
    ),
  );
  assert.ok(!variant.some((part) => /x264|x265|gpl|nonfree/i.test(part)));
  for (const [name, digest] of Object.entries(MEDIA_ENGINE_FILES))
    assert.equal(
      createHash("sha256")
        .update(
          readFileSync(
            new URL(
              `../scripts/media-engine/artifacts/${name}`,
              import.meta.url,
            ),
          ),
        )
        .digest("hex"),
      digest,
      name,
    );
});

test("the media worker accepts only well formed page messages", () => {
  const worker = readFileSync(
    new URL("../public/video-decoders/media.worker.js", import.meta.url),
    "utf8",
  );
  assert.match(worker, /event\.origin !== ""/);
  assert.match(worker, /!isValid\(event\.data\)/);
  // No network access of its own: bytes come from the page only.
  assert.doesNotMatch(worker, /\bfetch\(|XMLHttpRequest|importScripts/);
});
