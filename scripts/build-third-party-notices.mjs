import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = path.join(root, "frontend");
const lockFile = path.join(packageRoot, "package-lock.json");
const output = path.join(packageRoot, "public/THIRD_PARTY_NOTICES.txt");
const NOTICE_FILE = /^(licen[cs]e|copying|notice)([._-].*)?$/i;
const SEPARATOR = "-".repeat(78);
const HEADER = `Third-party software included in the PrivCloud Sharing web frontend.

Image and video decoders keep their own license files next to them, under
/image-decoders, /video-decoders and /forensic.
`;

function declaredLicense(manifest, entry) {
  const license = manifest.license ?? entry.license;
  if (typeof license === "string") return license;
  if (license?.type) return license.type;
  return "not declared";
}

async function describe(key, entry) {
  const directory = path.resolve(
    packageRoot,
    entry.link ? entry.resolved : key,
  );
  if (!directory.startsWith(packageRoot + path.sep)) {
    throw new Error(`Package outside the frontend: ${key}`);
  }
  let manifest;
  try {
    manifest = JSON.parse(
      await readFile(path.join(directory, "package.json"), "utf8"),
    );
  } catch {
    // Optional platform packages are not installed.
    return null;
  }
  const items = await readdir(directory, { withFileTypes: true });
  const names = items
    .filter((item) => item.isFile() && NOTICE_FILE.test(item.name))
    .map((item) => item.name)
    .sort();
  const texts = await Promise.all(
    names.map((name) => readFile(path.join(directory, name), "utf8")),
  );
  const name = manifest.name ?? key.split("node_modules/").pop();
  return {
    id: `${name}@${manifest.version ?? entry.version ?? "unknown"}`,
    license: declaredLicense(manifest, entry),
    texts,
  };
}

const { packages } = JSON.parse(await readFile(lockFile, "utf8"));
const described = await Promise.all(
  Object.entries(packages)
    .filter(([key, entry]) => key.includes("node_modules/") && !entry.dev)
    .map(([key, entry]) => describe(key, entry)),
);
const unique = new Map(
  described.filter(Boolean).map((item) => [item.id, item]),
);
const sections = [...unique.values()]
  .sort((a, b) => (a.id < b.id ? -1 : 1))
  .map((item) =>
    [`${item.id}`, `License: ${item.license}`, "", ...item.texts]
      .join("\n")
      .trimEnd(),
  );
await writeFile(
  output,
  [HEADER, ...sections].join(`\n${SEPARATOR}\n\n`) + "\n",
);
