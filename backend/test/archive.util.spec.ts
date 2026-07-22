import assert from "node:assert/strict";
import { once } from "node:events";
import { createZipArchive } from "../src/utils/archive.util";

void (async () => {
  const archive = createZipArchive({ zlib: { level: 1 } });
  const chunks: Buffer[] = [];
  archive.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));

  const ended = once(archive, "end");
  archive.append(Buffer.from("PrivCloud archive smoke test"), {
    name: "runtime.txt",
  });
  await archive.finalize();
  await ended;

  const zip = Buffer.concat(chunks);
  assert.equal(zip.subarray(0, 4).toString("hex"), "504b0304");
  assert.ok(zip.includes(Buffer.from("runtime.txt")));
  console.log("ok - creates a ZIP through the Archiver 8 named export");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
