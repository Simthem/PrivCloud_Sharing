// Copies the image decoders of public/image-decoders/decoder.worker.js from
// node_modules, unmodified, with their licenses. libheif and libde265 are
// LGPL-3.0: served as separate files, they stay replaceable by the user.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import ts from "typescript";

const require = createRequire(import.meta.url);
const destination = new URL("../public/image-decoders/", import.meta.url);

export const packageFile = (name, relative) =>
  require.resolve(`${name}/package.json`).replace(/package\.json$/, relative);

export const versionOf = async (name) =>
  JSON.parse(await readFile(packageFile(name, "package.json"), "utf8")).version;

// The worker CSP allows WebAssembly, not eval: a release generating code from
// strings must be reviewed before it can be shipped.
export const assertNoDynamicCode = (name, source) =>
  assert.doesNotMatch(
    source,
    /\bnew\s+Function\s*\(|(?<![\w$.])Function\s*\(|(?<![\w$.])eval\s*\(/,
    `${name} generates code at runtime. Review it before updating.`,
  );

const copies = [
  ["libheif-js", "libheif-wasm/libheif.js", "libheif.js"],
  ["libheif-js", "libheif-wasm/libheif.wasm", "libheif.wasm"],
  ["libheif-js", "libheif-wasm/LICENSE", "LIBHEIF_LICENSE.txt"],
  ["libheif-js", "LICENSE", "LIBHEIF_JS_LICENSE.txt"],
  ["utif2", "UTIF.js", "UTIF.js"],
  ["utif2", "LICENSE", "UTIF_LICENSE.txt"],
  ["pako", "dist/pako_inflate.min.js", "pako_inflate.min.js"],
  ["pako", "LICENSE", "PAKO_LICENSE.txt"],
];

/** A worker core: TypeScript without imports, served as an ES module. */
export async function transpileStandalone(source) {
  const core = ts.transpileModule(await readFile(source, "utf8"), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.ESNext,
    },
    reportDiagnostics: true,
  });
  assert.equal(core.diagnostics.length, 0);
  assert.doesNotMatch(core.outputText, /^\s*import\s/m);
  return core.outputText;
}

export async function buildImageDecoders() {
  assert.equal(await versionOf("libheif-js"), "1.23.5");
  assert.equal(await versionOf("utif2"), "4.1.0");
  assert.equal(await versionOf("pako"), "1.0.11");
  await mkdir(destination, { recursive: true });
  for (const [name, relative, target] of copies) {
    const bytes = await readFile(packageFile(name, relative));
    if (target.endsWith(".js")) assertNoDynamicCode(name, bytes.toString());
    await writeFile(new URL(target, destination), bytes);
  }
  await writeFile(
    new URL("decoder-core.mjs", destination),
    await transpileStandalone(
      new URL("../src/utils/imageDecoderCore.util.ts", import.meta.url),
    ),
  );
  await writeFile(new URL("NOTICE.txt", destination), NOTICE);
}

const NOTICE = `Image decoders used by decoder.worker.js, served unmodified:

libheif.js, libheif.wasm: libheif-js 1.23.5, an Emscripten build of libheif
  with libde265 1.0.15. LGPL-3.0, see LIBHEIF_LICENSE.txt and
  LIBHEIF_JS_LICENSE.txt. Sources: https://github.com/catdad-experiments/libheif-js,
  https://github.com/strukturag/libheif, https://github.com/strukturag/libde265
UTIF.js: utif2 4.1.0. MIT, see UTIF_LICENSE.txt.
pako_inflate.min.js: pako 1.0.11. MIT, see PAKO_LICENSE.txt.

These files may be replaced by any compatible build of the same libraries.
`;

if (
  process.argv[1] &&
  import.meta.url === new URL(process.argv[1], "file:").href
) {
  await buildImageDecoders();
}
