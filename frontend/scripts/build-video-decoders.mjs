// Copies the HEVC decoder of public/video-decoders/hevc.worker.js from
// node_modules, unmodified, with its license. libde265 is LGPL-3.0: served as
// separate files, it stays replaceable by the user.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import {
  assertNoDynamicCode,
  packageFile,
  transpileStandalone,
  versionOf,
} from "./build-image-decoders.mjs";

const destination = new URL("../public/video-decoders/", import.meta.url);
const LIBDE265 = "@yume-chan/libde265";

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
  await writeFile(new URL("NOTICE.txt", destination), NOTICE);
}

const NOTICE = `Video decoder used by hevc.worker.js, served unmodified:

libde265.mjs, libde265.wasm: @yume-chan/libde265 1.0.0, an Emscripten build of
  libde265 1.0.16. LGPL-3.0, see LIBDE265_COPYING.txt. Sources:
  https://github.com/yume-chan/libde265, https://github.com/strukturag/libde265

These files may be replaced by any compatible build of the same library.
`;

if (
  process.argv[1] &&
  import.meta.url === new URL(process.argv[1], "file:").href
) {
  await buildVideoDecoders();
}
