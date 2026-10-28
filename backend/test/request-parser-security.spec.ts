import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { IncomingMessage } from "node:http";
import { createRequire } from "node:module";
import { Socket } from "node:net";
import { setImmediate as nextTurn } from "node:timers/promises";
import test from "node:test";
import { brotliCompressSync, gzipSync } from "node:zlib";
import bodyParser from "body-parser";
import multer from "multer";
import { Request, Response } from "express";

function request(headers: Record<string, string>) {
  const message = new IncomingMessage(new Socket());
  message.headers = headers;
  message.method = "POST";
  message.url = "/";
  return message as Request;
}

test("the installed request parsers match their patched lock entries", () => {
  const loadPackage = createRequire(__filename);
  const manifest = loadPackage("../package.json");
  const lock = loadPackage("../package-lock.json");
  for (const [name, version] of [
    ["body-parser", "2.4.0"],
    ["multer", "2.5.0"],
    ["qs", "6.17.0"],
  ]) {
    assert.equal(lock.packages["node_modules/" + name].version, version);
    assert.equal(loadPackage(name + "/package.json").version, version);
  }
  assert.equal(manifest.dependencies["body-parser"], "2.4.0");
  assert.equal(manifest.overrides["body-parser"], "$body-parser");
  assert.equal(manifest.overrides.multer, "2.5.0");
  assert.equal(manifest.overrides.qs, "6.17.0");
  for (const [location, entry] of Object.entries(lock.packages)) {
    if (/node_modules\/(?:body-parser|multer)$/.test(location)) {
      assert.equal(
        (entry as { version: string }).version,
        location.endsWith("/multer") ? "2.5.0" : "2.4.0",
      );
    }
  }
});

test(
  "JSON and compressed bodies still parse without a network listener",
  { timeout: 3000 },
  async () => {
    const plain = Buffer.from(JSON.stringify({ value: "preserved" }));
    for (const [encoding, payload] of [
      ["identity", plain],
      ["gzip", gzipSync(plain)],
      ["br", brotliCompressSync(plain)],
    ] as const) {
      const req = request({
        "content-type": "application/json",
        "content-encoding": encoding,
        "content-length": String(payload.length),
      });
      const result = new Promise<void>((resolve, reject) => {
        bodyParser.json()(req, {} as Response, (error) =>
          error ? reject(error) : resolve(),
        );
      });
      req.push(payload);
      req.push(null);
      await result;
      assert.deepEqual(req.body, { value: "preserved" });
      req.socket.destroy();
    }
  },
);

test(
  "compressed bodies with trailing bytes cannot leave an unhandled decoder error",
  { timeout: 3000 },
  async () => {
    for (const [encoding, compress] of [
      ["gzip", gzipSync],
      ["br", brotliCompressSync],
    ] as const) {
      const compressed = compress(Buffer.from('{"value":"preserved"}'));
      const trailing = randomBytes(16);
      const req = request({
        "content-type": "application/json",
        "content-encoding": encoding,
        "content-length": String(compressed.length + trailing.length),
      });
      let calls = 0;
      const result = new Promise<unknown>((resolve) => {
        bodyParser.json()(req, {} as Response, (error) => {
          calls++;
          resolve(error);
        });
      });
      req.push(compressed);
      await nextTurn();
      req.push(trailing);
      req.push(null);
      const error = await result;
      if (error) assert.equal((error as { status: number }).status, 400);
      else assert.deepEqual(req.body, { value: "preserved" });
      await nextTurn();
      await nextTurn();
      assert.equal(calls, 1);
      req.socket.destroy();
    }
  },
);

test(
  "an asynchronous multipart filter cannot store a file after request teardown",
  { timeout: 3000 },
  async () => {
    const boundary = randomBytes(12).toString("hex");
    const req = request({
      "content-type": "multipart/form-data; boundary=" + boundary,
      "transfer-encoding": "chunked",
    });
    let finishFilter!: multer.FileFilterCallback;
    let filterStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      filterStarted = resolve;
    });
    let writes = 0;
    let calls = 0;
    const upload = multer({
      fileFilter: (_req, _file, callback) => {
        finishFilter = callback;
        filterStarted();
      },
      storage: {
        _handleFile: (_req, _file, callback) => {
          writes++;
          callback(null, {});
        },
        _removeFile: (_req, _file, callback) => callback(null),
      },
    }).single("file");
    const result = new Promise<unknown>((resolve) => {
      upload(req, {} as Response, (error) => {
        calls++;
        resolve(error);
      });
    });
    req.push(
      "--" +
        boundary +
        '\r\nContent-Disposition: form-data; name="file"; filename="sample.txt"\r\nContent-Type: text/plain\r\n\r\ncontent',
    );
    await started;
    req.emit("aborted");
    req.push(null);
    assert.match(String(await result), /aborted/);
    await nextTurn();
    finishFilter(null, true);
    await nextTurn();
    await nextTurn();
    assert.equal(writes, 0);
    assert.equal(calls, 1);
    req.socket.destroy();
  },
);

test("qs encodes empty-array keys without injecting parameters or URL fragments", () => {
  const loadPackage = createRequire(__filename);
  const qs = loadPackage("qs") as {
    stringify: (value: object, options: object) => string;
    parse: (value: string) => Record<string, unknown>;
  };
  const query = qs.stringify(
    { "x&apiKey=untrusted&y": [], apiKey: "trusted" },
    { allowEmptyArrays: true },
  );
  assert.equal(qs.parse(query).apiKey, "trusted");
  assert.ok(query.includes("x%26apiKey%3Duntrusted%26y[]"));
  assert.equal(
    qs.stringify({ "x#": [], z: "1" }, { allowEmptyArrays: true }),
    "x%23[]&z=1",
  );
});
