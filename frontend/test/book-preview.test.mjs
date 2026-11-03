import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import fixtures from "./fixtures/office-documents.cjs";
import { openOfficeDocument } from "../src/utils/officeDocumentPreview.util.ts";
import {
  contentDecidedMimeType,
  doesFileSupportPreview,
  isModelPreviewMimeType,
  resolveFileMimeType,
} from "../src/utils/filePreview.util.ts";

const parser = new new JSDOM("").window.DOMParser();
const open = (entries, mime) => {
  const bytes = fixtures.officePackage(entries);
  return openOfficeDocument(
    {
      size: bytes.length,
      read: async (start, end) => bytes.slice(start, end),
    },
    new AbortController().signal,
    mime,
    parser,
  );
};
const text = (block) => block.runs.map((run) => run.text).join("");

const container = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;
const opf = `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/" version="3.0">
  <metadata><dc:title>Le livre</dc:title></metadata>
  <manifest>
    <item id="c1" href="text/chapter%201.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="text/two.xhtml" media-type="application/xhtml+xml"/>
    <item id="css" href="style.css" media-type="text/css"/>
    <item id="img" href="images/pixel.png" media-type="image/png"/>
  </manifest>
  <spine><itemref idref="c1"/><itemref idref="css"/><itemref idref="c2"/></spine>
</package>`;
const chapter = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Ignored</title><style>p{}</style></head>
<body><h1>Chapitre&nbsp;un</h1><p>Il <em>était</em> une <strong>fois</strong>.</p>
<div><img src="../images/pixel.png" alt=""/></div><script>alert(1)</script>
<pre>  code
  kept</pre></body></html>`;

test("EPUB follows the spine and keeps headings, emphasis, images and preformatted text", async () => {
  const doc = await open(
    {
      mimetype: "application/epub+zip",
      "META-INF/container.xml": container,
      "OEBPS/content.opf": opf,
      "OEBPS/text/chapter 1.xhtml": chapter,
      "OEBPS/text/two.xhtml":
        '<html xmlns="http://www.w3.org/1999/xhtml"><body><p>Fin</p></body></html>',
      "OEBPS/images/pixel.png": fixtures.png,
    },
    "application/epub+zip",
  );
  assert.equal(doc.kind, "document");
  assert.deepEqual(
    doc.units.map((unit) => unit.name),
    ["Le livre", "two.xhtml"],
  );
  const page = await doc.load(0);
  const [heading, paragraph, image, pre] = page.blocks;
  assert.equal(heading.heading, 1);
  assert.equal(text(heading), "Chapitre un");
  assert.equal(text(paragraph), "Il était une fois.");
  assert.deepEqual(paragraph.runs[1].style, { fontStyle: "italic" });
  assert.deepEqual(paragraph.runs[3].style, { fontWeight: 700 });
  assert.deepEqual(image, { kind: "image", path: "OEBPS/images/pixel.png" });
  assert.ok(await doc.image(image.path));
  assert.equal(text(pre), "  code\n  kept");
  assert.equal(page.blocks.length, 4);
  assert.ok(!JSON.stringify(page.blocks).includes("alert"));
  assert.equal(text((await doc.load(1)).blocks[0]), "Fin");
});

test("EPUB refuses entities and parts outside the package", async () => {
  const entries = {
    "META-INF/container.xml": container,
    "OEBPS/content.opf": opf.replace("text/two.xhtml", "../../outside.xhtml"),
    "OEBPS/text/chapter 1.xhtml":
      '<!DOCTYPE html [<!ENTITY x "y">]><html xmlns="http://www.w3.org/1999/xhtml"><body>&x;</body></html>',
  };
  const doc = await open(entries, "application/epub+zip");
  assert.equal(doc.units.length, 1);
  await assert.rejects(doc.load(0));
});

test("Pages, Numbers and Keynote show the picture saved in the package", async () => {
  for (const [name, mime] of [
    ["Rapport.pages", "application/vnd.apple.pages"],
    ["Budget.numbers", "application/vnd.apple.numbers"],
  ]) {
    assert.equal(resolveFileMimeType(name), mime);
    assert.equal(doesFileSupportPreview(name), true);
    const doc = await open(
      { "Index/Document.iwa": "x", "preview.jpg": fixtures.png },
      mime,
    );
    const page = await doc.load(0);
    assert.deepEqual(page.blocks, [{ kind: "image", path: "preview.jpg" }]);
    assert.ok(await doc.image("preview.jpg"));
    assert.equal(await doc.image("Index/Document.iwa"), null);
  }
  await assert.rejects(
    open({ "Index/Document.iwa": "x" }, "application/vnd.apple.pages"),
  );
  assert.equal(
    contentDecidedMimeType("text/plain", fixtures.officePackage({ a: "b" })),
    "application/vnd.apple.keynote",
  );
});

test("3D models are recognised by name", () => {
  for (const name of ["a.stl", "a.obj", "a.ply", "a.glb", "a.gltf"]) {
    assert.equal(isModelPreviewMimeType(resolveFileMimeType(name)), true);
    assert.equal(doesFileSupportPreview(name), true);
  }
});
