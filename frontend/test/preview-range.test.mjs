import assert from "node:assert/strict";
import test from "node:test";
import { zipSync, strToU8 } from "fflate";
import { JSDOM } from "jsdom";
import {
  encryptFile,
  generateEncryptionKey,
} from "../src/utils/crypto.util.ts";
import {
  createPreviewByteSource,
  readVerifiedRange,
} from "../src/utils/previewRange.util.ts";
import {
  openPreviewZip,
  parseOfficeContent,
  OFFICE_XML_MAX_BYTES,
} from "../src/utils/officePreview.util.ts";
import {
  doesFileSupportPreview,
  sniffPreviewMimeType,
} from "../src/utils/filePreview.util.ts";

function storedFetcher(bytes, chunkSize, reads = []) {
  return async (start, end, signal) => {
    signal?.throwIfAborted();
    reads.push([start, end]);
    return new Response(bytes.slice(start, end + 1), {
      status: 206,
      headers: {
        "Content-Range": `bytes ${start}-${end}/${bytes.length}`,
        ...(chunkSize ? { "X-Encryption-Chunk-Size": String(chunkSize) } : {}),
      },
    });
  };
}

test("authenticates random ranges across AES-GCM boundaries and the short final record", async () => {
  const key = await generateEncryptionKey();
  const chunkSize = 1_000_000;
  const plain = new Uint8Array(2 * chunkSize + 17).map((_, i) => i % 251);
  const parts = [];
  for (let i = 0; i < plain.length; i += chunkSize)
    parts.push(
      new Uint8Array(
        await encryptFile(plain.slice(i, i + chunkSize).buffer, key),
      ),
    );
  const stored = new Uint8Array(parts.reduce((sum, b) => sum + b.length, 0));
  let pos = 0;
  for (const part of parts) {
    stored.set(part, pos);
    pos += part.length;
  }
  const reads = [];
  const source = await createPreviewByteSource(
    storedFetcher(stored, chunkSize, reads),
    key,
  );
  assert.equal(source.size, plain.length);
  assert.deepEqual(
    await source.read(chunkSize - 5, chunkSize + 5),
    plain.slice(chunkSize - 5, chunkSize + 5),
  );
  assert.deepEqual(
    await source.read(plain.length - 10, plain.length),
    plain.slice(-10),
  );
  const count = reads.length;
  await source.read(plain.length - 5, plain.length);
  assert.equal(reads.length, count, "the latest record is cached");
  stored[20] ^= 1;
  const tampered = await createPreviewByteSource(
    storedFetcher(stored, chunkSize),
    key,
  );
  await assert.rejects(tampered.read(0, 10));
  assert.ok(reads.every(([start, end]) => end - start + 1 <= chunkSize + 28));
});

test("opens a logical 40 GB encrypted file using only the first metadata byte and requested records", async () => {
  const key = await generateEncryptionKey();
  const record = new Uint8Array(
    await encryptFile(new Uint8Array(1_000_000).fill(7).buffer, key),
  );
  const count = 40_000;
  const size = record.length * count;
  const reads = [];
  const source = await createPreviewByteSource(async (start, end) => {
    reads.push([start, end]);
    const bytes = new Uint8Array(end - start + 1);
    for (let n = 0; n < bytes.length; n++)
      bytes[n] = record[(start + n) % record.length];
    return new Response(bytes, {
      status: 206,
      headers: {
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "X-Encryption-Chunk-Size": "1000000",
      },
    });
  }, key);
  assert.equal(source.size, 40_000_000_000);
  assert.equal(reads.length, 1);
  assert.deepEqual(
    await source.read(source.size - 10, source.size),
    new Uint8Array(10).fill(7),
  );
  assert.equal(reads.length, 2);
});

test("legacy chunked and single-block files preserve their historical layouts", async () => {
  const key = await generateEncryptionKey();
  const plain = new Uint8Array(1_000_011).fill(29);
  const first = new Uint8Array(
    await encryptFile(plain.slice(0, 1_000_000).buffer, key),
  );
  const last = new Uint8Array(
    await encryptFile(plain.slice(1_000_000).buffer, key),
  );
  const chunked = new Uint8Array(first.length + last.length);
  chunked.set(first);
  chunked.set(last, first.length);
  const source = await createPreviewByteSource(storedFetcher(chunked), key);
  assert.deepEqual(
    await source.read(999_995, plain.length),
    plain.slice(999_995),
  );
  const single = await createPreviewByteSource(
    storedFetcher(new Uint8Array(await encryptFile(plain.buffer, key))),
    key,
  );
  assert.deepEqual(
    await single.read(plain.length - 20, plain.length),
    plain.slice(-20),
  );
});

test("rejects ignored, truncated, oversized and mismatched ranges and honors cancellation", async () => {
  await assert.rejects(
    readVerifiedRange(async () => new Response(new Uint8Array(20)), 0, 9),
  );
  for (const length of [9, 11])
    await assert.rejects(
      readVerifiedRange(
        async () =>
          new Response(new Uint8Array(length), {
            status: 206,
            headers: { "Content-Range": "bytes 0-9/20" },
          }),
        0,
        9,
      ),
    );
  const source = await createPreviewByteSource(
    storedFetcher(new Uint8Array(20)),
  );
  await assert.rejects(source.read(0, 21));
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(source.read(0, 10, abort.signal), {
    name: "AbortError",
  });
});

test("ODF and DOCX read only content entries, skip embedded images, and reject inflated size attacks", async () => {
  const xml =
    '<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"><office:body/></office:document-content>';
  const bytes = zipSync({
    "content.xml": strToU8(xml),
    "Pictures/large.png": [
      new Uint8Array(5 * 1024 * 1024).fill(7),
      { level: 0 },
    ],
  });
  const reads = [];
  const source = await createPreviewByteSource(
    storedFetcher(bytes, undefined, reads),
  );
  const zip = await openPreviewZip(source, new AbortController().signal);
  assert.equal(new TextDecoder().decode(await zip.read("content.xml")), xml);
  assert.ok(reads.reduce((n, [a, b]) => n + b - a + 1, 0) < 256_000);
  const bomb = zipSync({
    "content.xml": new Uint8Array(OFFICE_XML_MAX_BYTES + 1),
  });
  const bombSource = await createPreviewByteSource(storedFetcher(bomb));
  const bombZip = await openPreviewZip(
    bombSource,
    new AbortController().signal,
  );
  await assert.rejects(bombZip.read("content.xml"));
  // A lying directory size must also fail during bounded decompression.
  const lie = zipSync({ "content.xml": new Uint8Array(100_000) });
  const view = new DataView(lie.buffer);
  for (let i = 0; i < lie.length - 46; i++)
    if (view.getUint32(i, true) === 0x02014b50) {
      view.setUint32(i + 24, 1, true);
      break;
    }
  const lyingZip = await openPreviewZip(
    await createPreviewByteSource(storedFetcher(lie)),
    new AbortController().signal,
  );
  await assert.rejects(lyingZip.read("content.xml"));
});

test("Office content renders safe text, bounded repeated cells and rejects XML entities", () => {
  const window = new JSDOM("").window;
  const parser = new window.DOMParser();
  const xml = `<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"><office:body><text:h>Title</text:h><text:p>&lt;script&gt;alert(1)&lt;/script&gt;</text:p><table:table><table:table-row table:number-rows-repeated="999999999"><table:table-cell table:number-columns-repeated="999999999"><text:p>Cell</text:p></table:table-cell></table:table-row></table:table></office:body></office:document-content>`;
  const result = parseOfficeContent(xml, parser);
  assert.equal(result.blocks[0].kind, "heading");
  assert.equal(result.blocks[1].text, "<script>alert(1)</script>");
  assert.equal(result.blocks[2].rows.length, 200);
  assert.equal(result.blocks[2].rows[0].length, 50);
  assert.equal(result.truncated, true);
  assert.throws(() =>
    parseOfficeContent('<!DOCTYPE x [<!ENTITY a "secret">]><x>&a;</x>', parser),
  );
  assert.throws(() => parseOfficeContent("<x>", parser));
  window.close();
});

test("large video/audio/PDF/text sources and ODF/DOCX remain previewable without a source-size gate", () => {
  for (const name of [
    "video.mp4",
    "audio.mp3",
    "book.pdf",
    "large.json",
    "report.odt",
    "sheet.ods",
    "deck.odp",
    "report.docx",
  ])
    assert.equal(
      doesFileSupportPreview(name, {
        fileSizeBytes: 40_000_000_000,
        isE2EEncrypted: true,
      }),
      true,
      name,
    );
  const bytes = zipSync({
    mimetype: [
      strToU8("application/vnd.oasis.opendocument.text"),
      { level: 0 },
    ],
    "content.xml": strToU8("<x/>"),
  });
  assert.equal(
    sniffPreviewMimeType(bytes.slice(0, 128)),
    "application/vnd.oasis.opendocument.text",
  );
});

test("ODS, ODP and DOCX packages expose their expected table, slide and paragraph content", async () => {
  const window = new JSDOM("").window;
  const parser = new window.DOMParser();
  const samples = [
    [
      "content.xml",
      '<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"><office:body><office:spreadsheet><table:table table:name="Budget"><table:table-row><table:table-cell><text:p>42</text:p></table:table-cell></table:table-row></table:table></office:spreadsheet></office:body></office:document-content>',
      (blocks) => assert.equal(blocks[0].rows[0][0], "42"),
    ],
    [
      "content.xml",
      '<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"><office:body><office:presentation><draw:page draw:name="Slide 1"><draw:frame><draw:text-box><text:p>Hello<text:s text:c="3"/>slide</text:p></draw:text-box></draw:frame></draw:page></office:presentation></office:body></office:document-content>',
      (blocks) => {
        assert.equal(blocks[0].kind, "slide");
        assert.equal(blocks[1].text, "Hello   slide");
      },
    ],
    [
      "word/document.xml",
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>DOCX document</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>',
      (blocks) => {
        assert.equal(blocks[0].text, "DOCX document");
        assert.equal(blocks[1].rows[0][0], "Cell");
      },
    ],
  ];
  for (const [name, xml, verify] of samples) {
    const source = await createPreviewByteSource(
      storedFetcher(zipSync({ [name]: strToU8(xml) })),
    );
    const zip = await openPreviewZip(source, new AbortController().signal);
    verify(
      parseOfficeContent(new TextDecoder().decode(await zip.read(name)), parser)
        .blocks,
    );
  }
  window.close();
});

test("empty repeated Office rows share the global rendering budget", () => {
  const window = new JSDOM("").window;
  const tables =
    '<table:table><table:table-row table:number-rows-repeated="999999999"/></table:table>'.repeat(
      51,
    );
  const xml = `<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"><office:body>${tables}</office:body></office:document-content>`;
  const result = parseOfficeContent(xml, new window.DOMParser());
  assert.ok(
    result.blocks.reduce(
      (total, block) => total + (block.rows?.length || 0),
      0,
    ) <= 10_000,
  );
  assert.equal(result.truncated, true);
  window.close();
});
