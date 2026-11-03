import assert from "node:assert/strict";
import test from "node:test";
import { strToU8, zipSync } from "fflate";
import {
  contentDecidedMimeType,
  isContentDecidedName,
  sniffPreviewMimeType,
} from "../src/utils/filePreview.util.ts";

const bytes = (...parts) =>
  Uint8Array.from(
    parts.flatMap((part) =>
      typeof part === "string"
        ? [...part].map((char) => char.charCodeAt(0))
        : part,
    ),
  );

const ftyp = (major, ...compatible) =>
  bytes(
    [0, 0, 0, 16 + 4 * compatible.length],
    "ftyp",
    major,
    [0, 0, 2, 0],
    ...compatible,
  );

// EBML header holding only a DocType element.
const ebml = (docType) =>
  bytes(
    [
      0x1a,
      0x45,
      0xdf,
      0xa3,
      0x80 | (docType.length + 3),
      0x42,
      0x82,
      0x80 | docType.length,
    ],
    docType,
  );

// Little-endian TIFF with one directory of the given tags.
const tiff = (tags, mark = [0, 0]) => {
  const entries = tags.flatMap((tag) => [
    tag & 0xff,
    tag >> 8,
    3,
    0,
    1,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
  ]);
  return bytes(
    "II*\0",
    [10, 0, 0, 0],
    mark,
    [tags.length, 0],
    entries,
    [0, 0, 0, 0],
  );
};

test("WebM and Matroska are told apart by their EBML DocType", () => {
  assert.equal(sniffPreviewMimeType(ebml("webm")), "video/webm");
  assert.equal(sniffPreviewMimeType(ebml("matroska")), "video/x-matroska");
  // Without a readable DocType the file is opened as Matroska, which reads both.
  assert.equal(
    sniffPreviewMimeType(bytes([0x1a, 0x45, 0xdf, 0xa3, 0x80])),
    "video/x-matroska",
  );
});

test("MP4 audio and QuickTime keep their own type", () => {
  assert.equal(
    sniffPreviewMimeType(ftyp("M4A ", "M4A ", "mp42", "isom")),
    "audio/mp4",
  );
  assert.equal(sniffPreviewMimeType(ftyp("M4B ", "M4B ", "mp42")), "audio/mp4");
  assert.equal(sniffPreviewMimeType(ftyp("qt  ", "qt  ")), "video/quicktime");
  // An M4V lists M4A among its compatible brands and is still a video.
  assert.equal(
    sniffPreviewMimeType(ftyp("M4V ", "M4V ", "M4A ", "mp42")),
    "video/mp4",
  );
  assert.equal(sniffPreviewMimeType(ftyp("isom", "isom", "avc1")), "video/mp4");
});

test("FLAC and AIFF sound are recognized", () => {
  assert.equal(
    sniffPreviewMimeType(bytes("fLaC", [0, 0, 0, 34])),
    "audio/flac",
  );
  assert.equal(
    sniffPreviewMimeType(bytes("FORM", [0, 0, 0, 4], "AIFF")),
    "audio/aiff",
  );
  assert.equal(
    sniffPreviewMimeType(bytes("FORM", [0, 0, 0, 4], "AIFC")),
    "audio/aiff",
  );
});

test("DNG and CR2 raw photos are not taken for plain TIFF images", () => {
  assert.equal(sniffPreviewMimeType(tiff([0x0100, 0x0101])), "image/tiff");
  assert.equal(
    sniffPreviewMimeType(tiff([0x0100, 0xc612])),
    "image/x-adobe-dng",
  );
  assert.equal(
    sniffPreviewMimeType(tiff([0x0100], [0x43, 0x52])),
    "image/x-canon-cr2",
  );
  // A directory past the sniffed bytes leaves a plain TIFF.
  assert.equal(
    sniffPreviewMimeType(bytes("II*\0", [0xff, 0xff, 0, 0])),
    "image/tiff",
  );
});

test("legacy video containers keep their signatures", () => {
  assert.equal(
    sniffPreviewMimeType(bytes("RIFF", [0, 0, 0, 0], "AVI LIST")),
    "video/x-msvideo",
  );
  assert.equal(
    sniffPreviewMimeType(
      bytes([0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11, 0xa6, 0xd9]),
    ),
    "video/x-ms-asf",
  );
  assert.equal(
    sniffPreviewMimeType(bytes("FLV", [1, 5, 0, 0, 0, 9])),
    "video/x-flv",
  );
  assert.equal(
    sniffPreviewMimeType(bytes([0, 0, 1, 0xba, 0x44, 0])),
    "video/mpeg",
  );
});

test("names shared by text and binary formats are decided by their content", () => {
  for (const name of [
    "clip.ts",
    "CLIP.MTS",
    "deploy.key",
    "Slides.KEY",
    "id_ed25519.pub",
    "flyer.pub",
  ])
    assert.equal(isContentDecidedName(name), true, name);
  for (const name of [
    "clip.mp4",
    "notes.txt",
    "keys.json",
    "public.pem",
    undefined,
  ])
    assert.equal(isContentDecidedName(name), false, String(name));

  const transport = new Uint8Array(188 * 4);
  for (let packet = 0; packet < 4; packet++) transport[packet * 188] = 0x47;
  assert.equal(
    contentDecidedMimeType("application/typescript", transport),
    "video/mp2t",
  );
  assert.equal(
    contentDecidedMimeType(
      "application/typescript",
      strToU8("export const answer = 42;\n"),
    ),
    "application/typescript",
  );

  const pemKey = strToU8(
    "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEI\n-----END PRIVATE KEY-----\n",
  );
  assert.equal(contentDecidedMimeType("text/plain", pemKey), "text/plain");
  // Legacy single-byte and UTF-16 text stay text.
  assert.equal(
    contentDecidedMimeType("text/plain", bytes("cl\xe9 publique\n")),
    "text/plain",
  );
  assert.equal(
    contentDecidedMimeType("text/plain", bytes([0xff, 0xfe], "k\0e\0y\0")),
    "text/plain",
  );

  // A Keynote presentation is a ZIP package, shown by its saved picture. A
  // Publisher document is an OLE2 file.
  const keynote = zipSync({
    "Index/Document.iwa": strToU8("slides"),
    "Metadata/Properties.plist": strToU8("<plist/>"),
  });
  assert.equal(
    contentDecidedMimeType("text/plain", keynote),
    "application/vnd.apple.keynote",
  );
  const publisher = bytes([
    0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0,
  ]);
  assert.equal(contentDecidedMimeType("text/plain", publisher), null);
  assert.equal(
    contentDecidedMimeType("application/typescript", publisher),
    null,
  );
});
