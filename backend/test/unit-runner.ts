import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";

function collectSpecs(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return collectSpecs(entryPath);
    return entry.name.endsWith(".spec.ts") ? [entryPath] : [];
  });
}

const specs = [
  ...collectSpecs(path.resolve("src")),
  ...collectSpecs(path.resolve("test")),
  path.resolve("..", "scripts", "docker", "entrypoint.test.mjs"),
].sort();

async function runSpec(spec: string) {
  await new Promise<void>((resolve, reject) => {
    const args = spec.endsWith(".ts")
      ? ["-r", "ts-node/register", spec]
      : [spec];
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      env: { ...process.env, NODE_PATH: process.cwd() },
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `${path.relative(process.cwd(), spec)} failed with exit code ${code}`,
        ),
      );
    });
  });
}

void (async () => {
  for (const spec of specs) {
    console.log(`\n# ${path.relative(process.cwd(), spec)}`);
    await runSpec(spec);
  }
  console.log(`\n${specs.length} unit spec files passed`);
})();
