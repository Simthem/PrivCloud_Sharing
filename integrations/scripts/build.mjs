import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const integrationsDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const repositoryDirectory = path.resolve(integrationsDirectory, "..");
const PLACEHOLDER_ORIGIN = "https://share.example.com";
const TEXT_EXTENSIONS = new Set([
  ".gs",
  ".html",
  ".js",
  ".json",
  ".md",
  ".ps1",
  ".sh",
  ".xml",
]);
const PACKAGES = [
  {
    id: "browser-extension",
    source: "browser-extension",
    artifact: (version) => `privcloud-browser-extension-${version}.zip`,
  },
  {
    id: "thunderbird-extension",
    source: "thunderbird-extension",
    artifact: (version) => `privcloud-thunderbird-extension-${version}.xpi`,
  },
  {
    id: "outlook-addin",
    source: "outlook-addin",
    artifact: (version) => `privcloud-outlook-addin-${version}.zip`,
  },
  {
    id: "google-workspace-addon",
    source: "gmail-workspace-addon",
    artifact: (version) => `privcloud-google-workspace-addon-${version}.zip`,
  },
  {
    id: "desktop-browser-helpers",
    source: "desktop",
    artifact: (version) => `privcloud-desktop-browser-helpers-${version}.zip`,
  },
];

const crcTable = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) {
    crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return crc >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createStoredZip(entries) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;

  for (const entry of [...entries].sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.from(entry.data);
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(33, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(33, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE((entry.mode << 16) >>> 0, 38);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, name);
    localOffset += local.length + name.length + data.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(localOffset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, ...centralParts, end]);
}

function normalizeBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("--base-url must be an absolute URL");
  }
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error(
      "--base-url must use HTTPS, except for loopback development",
    );
  }
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "--base-url must be an origin without credentials, path, query or fragment",
    );
  }
  return url.origin;
}

async function collectFiles(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const collected = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = path.join(directory, entry.name);
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) {
      collected.push(...(await collectFiles(absolute, relative)));
    } else if (entry.isFile()) {
      collected.push({ absolute, relative });
    }
  }
  return collected;
}

function transformText({ packageId, relative, text, baseUrl, version }) {
  let transformed = text
    .replaceAll(PLACEHOLDER_ORIGIN, baseUrl)
    .replaceAll("share.example.com", new URL(baseUrl).host);
  if (
    relative === "manifest.json" &&
    ["browser-extension", "thunderbird-extension"].includes(packageId)
  ) {
    const manifest = JSON.parse(transformed);
    manifest.version = version;
    transformed = `${JSON.stringify(manifest, null, 2)}\n`;
  }
  if (packageId === "outlook-addin" && relative === "manifest.xml") {
    transformed = transformed.replace(
      /<Version>[^<]+<\/Version>/,
      `<Version>${version}.0</Version>`,
    );
  }
  return transformed;
}

async function packageEntries(descriptor, options) {
  const sourceDirectory = path.join(integrationsDirectory, descriptor.source);
  const files = await collectFiles(sourceDirectory);
  return Promise.all(
    files.map(async ({ absolute, relative }) => {
      let data = await readFile(absolute);
      if (TEXT_EXTENSIONS.has(path.extname(relative).toLowerCase())) {
        data = Buffer.from(
          transformText({
            packageId: descriptor.id,
            relative,
            text: data.toString("utf8"),
            baseUrl: options.baseUrl,
            version: options.version,
          }),
        );
      }
      return {
        name: relative,
        data,
        mode: relative.endsWith(".sh") ? 0o100755 : 0o100644,
      };
    }),
  );
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export async function buildIntegrations({ baseUrl, outputDirectory } = {}) {
  const canonicalBaseUrl = normalizeBaseUrl(baseUrl || "");
  const destination = path.resolve(
    outputDirectory || path.join(integrationsDirectory, "dist"),
  );
  const rootPackage = JSON.parse(
    await readFile(path.join(repositoryDirectory, "package.json"), "utf8"),
  );
  const version = rootPackage.version;

  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });

  const artifacts = [];
  for (const descriptor of PACKAGES) {
    const entries = await packageEntries(descriptor, {
      baseUrl: canonicalBaseUrl,
      version,
    });
    const archive = createStoredZip(entries);
    const name = descriptor.artifact(version);
    await writeFile(path.join(destination, name), archive);
    artifacts.push({
      id: descriptor.id,
      name,
      bytes: archive.length,
      sha256: sha256(archive),
    });
  }

  const manifest = {
    version,
    baseUrl: canonicalBaseUrl,
    artifacts,
  };
  await writeFile(
    path.join(destination, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  await writeFile(
    path.join(destination, "SHA256SUMS"),
    `${artifacts.map((artifact) => `${artifact.sha256}  ${artifact.name}`).join("\n")}\n`,
  );
  return { destination, manifest };
}

function readArgument(argv, name) {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const result = await buildIntegrations({
    baseUrl: readArgument(argv, "--base-url") || process.env.PRIVCLOUD_BASE_URL,
    outputDirectory: readArgument(argv, "--output-dir"),
  });
  process.stdout.write(
    `${result.manifest.artifacts.length} integration artifacts ${result.manifest.version} generated in ${result.destination}\n`,
  );
}
