// Rebuilds scripts/media-engine/artifacts/ with Docker: downloads the pinned
// libav.js, FFmpeg and emfiberthreads sources, checks their SHA-256, then
// compiles them in the pinned Emscripten image without network. Run it after
// changing scripts/media-engine/, then update MEDIA_ENGINE_FILES in
// scripts/build-video-decoders.mjs with the digests it prints.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const recipe = fileURLToPath(new URL("media-engine/", import.meta.url));
const artifacts = join(recipe, "artifacts");
const SOURCES = [
  [
    "libav.js.tar.gz",
    "https://github.com/Yahweasel/libav.js/archive/refs/tags/v6.10.9.0.tar.gz",
    "3b640c356d74724a99230b077ef442d8c995a37c03e0729d6d2a9be0f3a41fd3",
  ],
  [
    "ffmpeg.tar.xz",
    "https://ffmpeg.org/releases/ffmpeg-9.0.tar.xz",
    "7f607a00dd0d28a729d5a4811205812eef01cf6ef6155025febb6f36a9062d52",
  ],
  [
    "emfiberthreads.tar.gz",
    "https://github.com/Yahweasel/emfiberthreads/archive/refs/tags/v1.3.tar.gz",
    "0fe933d7742de3b3213608e0fb087a1ae0d060604d5835f7c9cdfcee0fc8cbcb",
  ],
];

const context = await mkdtemp(join(tmpdir(), "media-engine-"));
try {
  for (const [name, url, digest] of SOURCES) {
    const response = await fetch(url, { redirect: "follow" });
    assert.ok(response.ok, `${url}: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(createHash("sha256").update(bytes).digest("hex"), digest, url);
    await writeFile(join(context, name), bytes);
  }
  for (const name of ["Dockerfile", "variant.json"])
    await copyFile(join(recipe, name), join(context, name));
  execFileSync(
    "docker",
    [
      "build",
      "--network=none",
      "--output",
      `type=local,dest=${artifacts}`,
      context,
    ],
    { stdio: "inherit", env: { ...process.env, DOCKER_BUILDKIT: "1" } },
  );
  for (const name of (await readdir(artifacts)).sort())
    console.log(
      createHash("sha256")
        .update(await readFile(join(artifacts, name)))
        .digest("hex"),
      name,
    );
} finally {
  await rm(context, { recursive: true, force: true });
}
