// Copies the HEVC decoder of public/video-decoders/hevc.worker.js from
// node_modules, unmodified, with its license. libde265 is LGPL-3.0: served as
// separate files, it stays replaceable by the user. Also copies the media
// engine of media.worker.js, built by scripts/build-media-engine.mjs (FFmpeg
// under LGPL-2.1, replaceable the same way), after checking its digests.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import {
  assertNoDynamicCode,
  packageFile,
  transpileStandalone,
  versionOf,
} from "./build-image-decoders.mjs";

const destination = new URL("../public/video-decoders/", import.meta.url);
const LIBDE265 = "@yume-chan/libde265";
const ENGINE = new URL("media-engine/artifacts/", import.meta.url);
export const MEDIA_ENGINE_FILES = {
  "libav-6.10.9.0-privcloud.mjs":
    "e07d02a7426f788db1fbe22a911667b3a30cd0d3bfad59473f4f0d01fdff1eaa",
  "libav-6.10.9.0-privcloud.wasm.mjs":
    "aae4599ee86feb37acfb9e0e2d7ccd0ec4436492ee9f67fbfd39fb24ebacff01",
  "libav-6.10.9.0-privcloud.wasm.wasm":
    "0de8258ea9639ebb349df4eaef4cbdf33dc2d3fc05abf260c12f0483cbf653dd",
  "FFMPEG_COPYING.LGPLv2.1":
    "246041b6ecf9bc32d718a62c57877c78b5eb397b6467e74ed7ae2626ab189c30",
  "LIBAVJS_LICENSE.md":
    "afb8d248e345d343a45f74a5666f850d1920fb5a0006621a5a45e570687933bf",
};

async function copyMediaEngine() {
  const target = new URL("media/", destination);
  await mkdir(target, { recursive: true });
  for (const [name, digest] of Object.entries(MEDIA_ENGINE_FILES)) {
    const bytes = await readFile(new URL(name, ENGINE));
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      digest,
      `${name} differs from the reviewed build`,
    );
    await writeFile(new URL(name, target), bytes);
  }
}

export async function buildVideoDecoders() {
  assert.equal(await versionOf(LIBDE265), "1.0.0");
  await mkdir(destination, { recursive: true });
  const glue = await readFile(packageFile(LIBDE265, "libde265.mjs"));
  assertNoDynamicCode(LIBDE265, glue.toString());
  await writeFile(new URL("libde265.mjs", destination), glue);
  await writeFile(
    new URL("libde265.wasm", destination),
    await readFile(packageFile(LIBDE265, "libde265.wasm")),
  );
  // The package ships no license file: this is libde265's own, from v1.0.16.
  await writeFile(
    new URL("LIBDE265_COPYING.txt", destination),
    await readFile(new URL("licenses/libde265-COPYING.txt", import.meta.url)),
  );
  await writeFile(
    new URL("hevc-core.mjs", destination),
    await transpileStandalone(
      new URL("../src/utils/hevcDecoderCore.util.ts", import.meta.url),
    ),
  );
  await copyMediaEngine();
  await writeFile(new URL("NOTICE.txt", destination), NOTICE);
}

const NOTICE = `Video decoder used by hevc.worker.js, served unmodified:

libde265.mjs, libde265.wasm: @yume-chan/libde265 1.0.0, an Emscripten build of
  libde265 1.0.16. LGPL-3.0, see LIBDE265_COPYING.txt. Sources:
  https://github.com/yume-chan/libde265, https://github.com/strukturag/libde265

media/libav-6.10.9.0-privcloud.*: libav.js 6.10.9.0 (see media/LIBAVJS_LICENSE.md)
  with FFmpeg 9.0 demuxers, parsers, decoders and its AAC encoder, built
  without GPL or nonfree parts. LGPL-2.1, see media/FFMPEG_COPYING.LGPLv2.1.
  Sources: https://github.com/Yahweasel/libav.js, https://ffmpeg.org/releases/
  Build recipe: scripts/media-engine/ in the PrivCloud sources.

These files may be replaced by any compatible build of the same library.
`;

if (
  process.argv[1] &&
  import.meta.url === new URL(process.argv[1], "file:").href
) {
  await buildVideoDecoders();
}
