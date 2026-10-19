export const CODE_HIGHLIGHT_MAX_CHARS = 128 * 1024;
export const CODE_HIGHLIGHT_MAX_TOKENS = 12_000;
export type CodeToken = { text: string; classes: string[] };
export type CodeHighlight = { tokens: CodeToken[]; limited: boolean };

const EXTENSIONS: Record<string, string> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "typescript",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  ino: "arduino",
  html: "xml",
  htm: "xml",
  xhtml: "xml",
  xml: "xml",
  svg: "xml",
  vue: "xml",
  svelte: "xml",
  css: "css",
  scss: "scss",
  less: "less",
  json: "json",
  jsonld: "json",
  py: "python",
  pyw: "python",
  java: "java",
  cs: "csharp",
  rs: "rust",
  go: "go",
  kt: "kotlin",
  kts: "kotlin",
  swift: "swift",
  rb: "ruby",
  php: "php",
  pl: "perl",
  lua: "lua",
  r: "r",
  m: "objectivec",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  sql: "sql",
  graphql: "graphql",
  gql: "graphql",
  yaml: "yaml",
  yml: "yaml",
  ini: "ini",
  toml: "ini",
  cfg: "ini",
  conf: "ini",
  diff: "diff",
  patch: "diff",
  vb: "vbnet",
  wat: "wasm",
  mk: "makefile",
  dart: "dart",
  scala: "scala",
  sc: "scala",
  ps1: "powershell",
  psm1: "powershell",
  psd1: "powershell",
  bat: "dos",
  cmd: "dos",
  fs: "fsharp",
  fsx: "fsharp",
  fsi: "fsharp",
  ex: "elixir",
  exs: "elixir",
  erl: "erlang",
  hrl: "erlang",
  hs: "haskell",
  lhs: "haskell",
  clj: "clojure",
  cljs: "clojure",
  cljc: "clojure",
  coffee: "coffeescript",
  groovy: "groovy",
  gradle: "gradle",
  jl: "julia",
  nim: "nim",
  nix: "nix",
  ml: "ocaml",
  mli: "ocaml",
  cmake: "cmake",
  proto: "protobuf",
  tex: "latex",
  sty: "latex",
  cls: "latex",
  bib: "latex",
  pas: "delphi",
  pp: "delphi",
  f: "fortran",
  f90: "fortran",
  f95: "fortran",
  asm: "x86asm",
  s: "x86asm",
  v: "verilog",
  sv: "verilog",
  vhd: "vhdl",
  vhdl: "vhdl",
  tcl: "tcl",
  d: "d",
  cr: "crystal",
  qml: "qml",
  vala: "vala",
  thrift: "thrift",
  smali: "smali",
  awk: "awk",
  adoc: "asciidoc",
  asciidoc: "asciidoc",
  properties: "properties",
  env: "bash",
  dockerfile: "dockerfile",
  json5: "javascript",
  jsonc: "javascript",
  jsonl: "json",
  ndjson: "json",
  hjson: "javascript",
  xsd: "xml",
  xsl: "xml",
  xslt: "xml",
  wsdl: "xml",
  csproj: "xml",
  fsproj: "xml",
  vbproj: "xml",
  props: "xml",
  targets: "xml",
  plist: "xml",
  resx: "xml",
  kml: "xml",
  gpx: "xml",
  rss: "xml",
  atom: "xml",
  hbs: "handlebars",
  handlebars: "handlebars",
  twig: "twig",
  haml: "haml",
  erb: "erb",
  styl: "stylus",
  feature: "gherkin",
  http: "http",
  rest: "http",
  gcode: "gcode",
  scad: "openscad",
};
const MIME_LANGUAGES: Record<string, string> = {
  "application/javascript": "javascript",
  "text/javascript": "javascript",
  "application/x-javascript": "javascript",
  "application/ecmascript": "javascript",
  "application/typescript": "typescript",
  "text/typescript": "typescript",
  "text/x-c": "c",
  "text/x-c++": "cpp",
  "text/html": "xml",
  "application/xhtml+xml": "xml",
  "application/xml": "xml",
  "text/xml": "xml",
  "text/css": "css",
  "application/json": "json",
  "text/x-python": "python",
  "text/x-java-source": "java",
  "text/x-rust": "rust",
  "text/x-go": "go",
  "text/x-kotlin": "kotlin",
  "text/x-swift": "swift",
  "text/x-ruby": "ruby",
  "text/x-lua": "lua",
  "text/x-r": "r",
  "text/x-objectivec": "objectivec",
  "application/x-sh": "bash",
  "application/x-shellscript": "bash",
  "application/x-httpd-php": "php",
  "application/x-php": "php",
  "application/sql": "sql",
  "application/graphql": "graphql",
  "application/yaml": "yaml",
  "application/x-yaml": "yaml",
  "text/yaml": "yaml",
  "text/x-toml": "ini",
  "application/toml": "ini",
  "text/x-makefile": "makefile",
};

export function resolveCodeLanguage(
  fileName = "",
  mimeType = "",
): string | null {
  const name = fileName.split(/[\\/]/).pop()?.toLowerCase() || "";
  if (/^(gnu|bsd)?makefile$/.test(name)) return "makefile";
  if (name === "cmakelists.txt") return "cmake";
  if (/^dockerfile(?:\.|$)/.test(name)) return "dockerfile";
  if (
    /^\.env(?:\.|$)/.test(name) ||
    [".bashrc", ".bash_profile", ".zshrc", ".profile"].includes(name)
  )
    return "bash";
  if (name === "nginx.conf") return "nginx";
  if (name === ".htaccess" || name === "httpd.conf") return "apache";
  if (name === "jenkinsfile") return "groovy";
  if (["cargo.lock", "poetry.lock", "pipfile"].includes(name)) return "ini";
  if (["composer.lock", "package.lock", "pipfile.lock"].includes(name))
    return "json";
  if (name === "yarn.lock") return "yaml";
  if (name === "gemfile" || name === "rakefile" || name === "vagrantfile")
    return "ruby";
  const extension = name.match(/\.([a-z0-9]+)$/)?.[1];
  if (extension && Object.hasOwn(EXTENSIONS, extension))
    return EXTENSIONS[extension];
  const mime = mimeType.toLowerCase().split(";")[0].trim();
  if (Object.hasOwn(MIME_LANGUAGES, mime)) return MIME_LANGUAGES[mime];
  if (/^application\/.*\+json$/.test(mime)) return "json";
  if (/^application\/.*\+xml$/.test(mime)) return "xml";
  return null;
}

export const isCodeTokenClass = (value: unknown): value is string =>
  typeof value === "string" &&
  /^(hljs-[a-z][a-z0-9_-]{0,40}|[a-z][a-z0-9_-]{0,40}_|language-[a-z0-9-]{1,40})$/.test(
    value,
  );

export function isCodeHighlight(value: unknown): value is CodeHighlight {
  if (!value || typeof value !== "object") return false;
  const data = value as Record<string, unknown>;
  if (
    Object.keys(data).length !== 2 ||
    typeof data.limited !== "boolean" ||
    !Array.isArray(data.tokens) ||
    data.tokens.length > CODE_HIGHLIGHT_MAX_TOKENS
  )
    return false;
  let chars = 0;
  return data.tokens.every((token) => {
    if (!token || typeof token !== "object" || Object.keys(token).length !== 2)
      return false;
    return (
      typeof token.text === "string" &&
      (chars += token.text.length) <= CODE_HIGHLIGHT_MAX_CHARS &&
      Array.isArray(token.classes) &&
      token.classes.length <= 8 &&
      token.classes.every(isCodeTokenClass)
    );
  });
}
