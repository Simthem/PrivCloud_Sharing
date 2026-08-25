import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

const bridgeDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function parseOutputDirectory(argv) {
  const index = argv.indexOf("--output-dir");
  if (index === -1) return path.join(bridgeDirectory, "dist");
  if (!argv[index + 1]) throw new Error("--output-dir requires a path");
  return path.resolve(argv[index + 1]);
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function collectFiles(directory, prefix) {
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

function writeTarOctal(header, offset, length, value) {
  const octal = value.toString(8).padStart(length - 1, "0");
  if (octal.length >= length) throw new Error("Tar numeric field overflow");
  header.write(`${octal}\0`, offset, length, "ascii");
}

function createTar(entries) {
  const parts = [];
  for (const entry of [...entries].sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const name = Buffer.from(entry.name, "utf8");
    if (name.length > 100) {
      throw new Error(`Tar path is too long: ${entry.name}`);
    }
    const data = Buffer.from(entry.data);
    const header = Buffer.alloc(512);
    name.copy(header, 0);
    writeTarOctal(header, 100, 8, entry.mode);
    writeTarOctal(header, 108, 8, 0);
    writeTarOctal(header, 116, 8, 0);
    writeTarOctal(header, 124, 12, data.length);
    writeTarOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header.write("0", 156, 1, "ascii");
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    const checksumText = checksum.toString(8).padStart(6, "0");
    header.write(`${checksumText}\0 `, 148, 8, "ascii");
    parts.push(header, data);
    const remainder = data.length % 512;
    if (remainder) parts.push(Buffer.alloc(512 - remainder));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

async function releaseEntries() {
  const files = [
    {
      absolute: path.join(bridgeDirectory, "package.json"),
      relative: "package/package.json",
    },
    {
      absolute: path.join(bridgeDirectory, "README.md"),
      relative: "package/README.md",
    },
    ...(await collectFiles(path.join(bridgeDirectory, "src"), "package/src")),
    ...(await collectFiles(
      path.join(bridgeDirectory, "install"),
      "package/install",
    )),
    ...(await collectFiles(
      path.join(bridgeDirectory, "native-messaging"),
      "package/native-messaging",
    )),
  ];
  return Promise.all(
    files.map(async ({ absolute, relative }) => ({
      name: relative,
      data: await readFile(absolute),
      mode:
        relative.endsWith(".sh") || relative.endsWith("privcloud-bridge.mjs")
          ? 0o755
          : 0o644,
    })),
  );
}

export async function buildCompanionRelease({ outputDirectory } = {}) {
  const destination = path.resolve(
    outputDirectory || path.join(bridgeDirectory, "dist"),
  );
  const packageJson = JSON.parse(
    await readFile(path.join(bridgeDirectory, "package.json"), "utf8"),
  );
  const source = await readFile(
    path.join(bridgeDirectory, "src/privcloud-bridge.mjs"),
    "utf8",
  );
  const declaredVersion = /const VERSION = "([^"]+)";/.exec(source)?.[1];
  if (declaredVersion !== packageJson.version) {
    throw new Error(
      `Companion source version ${declaredVersion || "missing"} does not match package ${packageJson.version}`,
    );
  }
  if (!/openSourceLocalAuthorization:\s*true/.test(source)) {
    throw new Error(
      "Companion is missing its open-source authorization marker",
    );
  }

  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });

  const artifactName = `privcloud-companion-${packageJson.version}.tgz`;
  const artifactPath = path.join(destination, artifactName);
  const artifact = gzipSync(createTar(await releaseEntries()), {
    level: 9,
    mtime: 0,
  });
  await writeFile(artifactPath, artifact);
  const digest = sha256(artifact);
  const manifest = {
    version: packageJson.version,
    artifacts: [
      {
        name: artifactName,
        bytes: artifact.length,
        sha256: digest,
      },
    ],
  };

  await writeFile(
    path.join(destination, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  await writeFile(
    path.join(destination, "SHA256SUMS"),
    `${digest}  ${artifactName}\n`,
  );
  return { destination, manifest };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const outputDirectory = parseOutputDirectory(process.argv.slice(2));
  const result = await buildCompanionRelease({ outputDirectory });
  process.stdout.write(
    `Companion ${result.manifest.version} generated in ${result.destination}\n`,
  );
}
