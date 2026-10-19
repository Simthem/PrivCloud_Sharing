import assert from "node:assert/strict";
import test from "node:test";
import { parseCodeHighlight } from "../src/utils/codeHighlightParser.util.ts";
import {
  CODE_HIGHLIGHT_MAX_CHARS,
  isCodeHighlight,
  resolveCodeLanguage,
} from "../src/utils/codePreview.util.ts";
import {
  resolveFileMimeType,
  doesFileSupportPreview,
} from "../src/utils/filePreview.util.ts";
import { decodePreviewText } from "../src/utils/textPreview.util.ts";

const samples = [
  [
    "example.js",
    "javascript",
    '// Commentaire\nconst label = "PrivCloud";\nconsole.log(label, 42);',
  ],
  [
    "example.c",
    "c",
    "#include <stdio.h>\nint main(void) { /* Commentaire */ return 42; }",
  ],
  [
    "example.html",
    "xml",
    '<!doctype html><html><body><script>window.uploadedCodeExecuted = true;</script><img src=x onerror="alert(1)"></body></html>',
  ],
  [
    "example.ts",
    "typescript",
    'interface Item { name: string }\nconst item: Item = { name: "PrivCloud" };',
  ],
  ["example.cpp", "cpp", "class Item { public: int size = 42; };"],
  ["example.css", "css", ".item { color: #123456; display: block; }"],
  ["example.py", "python", 'def greet(name):\n    return "Bonjour " + name'],
  ["example.json", "json", '{"name":"PrivCloud","count":42,"active":true}'],
  ["example.dart", "dart", 'void main() { print("PrivCloud"); }'],
  ["example.ps1", "powershell", '$name = "PrivCloud"\nWrite-Output $name'],
  ["Dockerfile", "dockerfile", 'FROM node:24\nRUN echo "PrivCloud"'],
  [
    "schema.proto",
    "protobuf",
    'syntax = "proto3";\nmessage Item { string name = 1; }',
  ],
];
for (const [name, language, source] of samples) {
  test(`${name} gets colored tokens while preserving every source character`, () => {
    assert.equal(doesFileSupportPreview(name), true);
    assert.equal(
      resolveCodeLanguage(name, resolveFileMimeType(name)),
      language,
    );
    const result = parseCodeHighlight(source, language);
    assert.equal(isCodeHighlight(result), true);
    assert.equal(result.tokens.map((token) => token.text).join(""), source);
    assert.ok(
      result.tokens.some((token) =>
        token.classes.some((value) => value.startsWith("hljs-")),
      ),
    );
    assert.equal(result.limited, false);
  });
}

test("source extensions disambiguate MIME types and plain text retains its meaning", () => {
  for (const [name, language] of [
    ["COMPONENT.TSX", "typescript"],
    ["component.jsx", "javascript"],
    ["script.mjs", "javascript"],
    ["script.cjs", "javascript"],
    ["header.h", "c"],
    ["header.hpp", "cpp"],
    ["Makefile", "makefile"],
    ["Gemfile", "ruby"],
    ["src\\sample.rs", "rust"],
    ["config.yaml", "yaml"],
  ])
    assert.equal(resolveCodeLanguage(name, "text/plain"), language);
  assert.equal(resolveFileMimeType("source.ts"), "application/typescript");
  assert.equal(resolveFileMimeType("source.tsx"), "application/typescript");
  assert.equal(resolveCodeLanguage("notes.txt", "text/plain"), null);
  assert.equal(resolveCodeLanguage("README.md", "text/markdown"), null);
  assert.equal(resolveCodeLanguage("", "application/javascript"), "javascript");
  assert.equal(resolveCodeLanguage("constructor", "toString"), null);
});

test("HTML remains text and worker output cannot inject tags, attributes or CSS", () => {
  const source = '<svg onload="alert(1)"><script>alert(1)</script></svg>';
  const result = parseCodeHighlight(source, "xml");
  assert.equal(result.tokens.map((token) => token.text).join(""), source);
  assert.ok(
    result.tokens.every(
      (token) => Object.keys(token).sort().join(",") === "classes,text",
    ),
  );
  for (const malicious of [
    { ...result, html: source },
    {
      tokens: [{ text: "x", classes: ['hljs-title" onclick="alert(1)'] }],
      limited: false,
    },
    {
      tokens: [{ text: "x", classes: ["hljs-title"], tag: "script" }],
      limited: false,
    },
    { tokens: [{ text: {}, classes: [] }], limited: false },
  ])
    assert.equal(isCodeHighlight(malicious), false);
});

test("large or highly fragmented code has bounded parse and rendering budgets", () => {
  assert.throws(
    () =>
      parseCodeHighlight(
        "x".repeat(CODE_HIGHLIGHT_MAX_CHARS + 1),
        "javascript",
      ),
    /budget/,
  );
  const source = "const a = 1;\n".repeat(4000);
  const limited = parseCodeHighlight(source, "javascript");
  assert.equal(limited.limited, true);
  assert.equal(isCodeHighlight(limited), true);
  assert.equal(limited.tokens.map(token => token.text).join(""), source);
  assert.ok(limited.tokens.some(token => token.classes.length > 0));
  assert.equal(limited.tokens.at(-1).classes.length, 0);
  assert.throws(
    () => parseCodeHighlight("hello", "unknown-language"),
    /unknown language/,
  );
  assert.equal(
    isCodeHighlight({
      tokens: [{ text: "x".repeat(CODE_HIGHLIGHT_MAX_CHARS + 1), classes: [] }],
      limited: false,
    }),
    false,
  );
});

test("common configuration, logs and structured text stay previewable", () => {
  for (const name of [
    "archive.util.ts",
    "CMakeLists.txt",
    ".env.local",
    ".gitignore",
    "nginx.conf",
    "app.log",
    "settings.properties",
    "message.eml",
    "captions.srt",
    "captions.vtt",
    "calendar.ics",
    "public.pem",
    "terraform.tf",
    "Cargo.lock",
    "component.vue",
  ])
    assert.equal(doesFileSupportPreview(name), true, name);
  for (const name of ["script.exe", "disk.iso", "backup.zip", "package.apk"])
    assert.equal(doesFileSupportPreview(name), false, name);
});

test("UTF-8, UTF-16 and legacy text preserve accents and range boundaries", () => {
  const source = "const équipe = 'PrivCloud';\n";
  assert.equal(decodePreviewText(new TextEncoder().encode(source)), source);
  const little = Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from(source, "utf16le"),
  ]);
  assert.equal(decodePreviewText(little), source);
  const big = Buffer.from(little);
  big.swap16();
  assert.equal(decodePreviewText(big), source);
  assert.equal(
    decodePreviewText(Uint8Array.from([0x63, 0x61, 0x66, 0xe9])),
    "café",
  );
  const cut = new TextEncoder().encode("équipe €").slice(0, -1);
  assert.equal(decodePreviewText(cut, true), "équipe ");
});
