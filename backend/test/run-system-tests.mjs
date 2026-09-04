import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

import { runCollection } from "./postman-collection-runner.mjs";

const commandName = (name) =>
  process.platform === "win32" ? `${name}.cmd` : name;

function startCommand(label, command, args, options = {}) {
  const detached = options.detached ?? false;
  const child = spawn(commandName(command), args, {
    cwd: process.cwd(),
    env: options.env ?? process.env,
    stdio: "inherit",
    detached,
  });

  const completed = new Promise((resolve) => {
    child.once("error", (error) => resolve({ error }));
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

  return { label, child, completed, detached };
}

function commandFailure(task, result) {
  if (result.error) {
    return new Error(`${task.label} could not start: ${result.error.message}`);
  }
  return new Error(
    `${task.label} exited before completion (code=${result.code ?? "null"}, signal=${result.signal ?? "none"})`,
  );
}

async function requireSuccess(task) {
  const result = await task.completed;
  if (result.error || result.code !== 0) throw commandFailure(task, result);
}

async function stopCommand(task) {
  if (
    !task?.child.pid ||
    task.child.exitCode !== null ||
    task.child.signalCode !== null
  )
    return;

  const signalProcess = (signal) => {
    try {
      if (task.detached && process.platform !== "win32") {
        process.kill(-task.child.pid, signal);
      } else {
        task.child.kill(signal);
      }
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  };

  signalProcess("SIGTERM");
  const stopped = await Promise.race([
    task.completed.then(() => true),
    delay(5_000, false),
  ]);
  if (!stopped) signalProcess("SIGKILL");
}

async function waitForBackend(server, env) {
  const readiness = startCommand(
    "backend readiness check",
    "wait-on",
    [
      "--timeout",
      "60000",
      "--interval",
      "250",
      "http-get://127.0.0.1:8080/api/configs",
    ],
    { env },
  );

  const winner = await Promise.race([
    readiness.completed.then((result) => ({ source: "readiness", result })),
    server.completed.then((result) => ({ source: "server", result })),
  ]);

  if (winner.source === "server") {
    await stopCommand(readiness);
    throw commandFailure(server, winner.result);
  }
  if (winner.result.error || winner.result.code !== 0) {
    throw commandFailure(readiness, winner.result);
  }
}

async function runSystemTests(server) {
  const collection = runCollection(
    "./test/system-tests.postman_collection.json",
  );
  const winner = await Promise.race([
    collection.then((result) => ({ source: "collection", result })),
    server.completed.then((result) => ({ source: "server", result })),
  ]);

  if (winner.source === "server") {
    throw commandFailure(server, winner.result);
  }
  if (winner.result.failures.length > 0) {
    throw new Error(
      `System tests failed (${winner.result.failures.length} of ${winner.result.assertions} assertions)`,
    );
  }
}

const temporaryRoot = await mkdtemp(
  path.join(os.tmpdir(), "privcloud-system-tests-"),
);
const dataDirectory = path.join(temporaryRoot, "data");
await mkdir(dataDirectory, { recursive: true });

const env = {
  ...process.env,
  BACKEND_PORT: "8080",
  CONFIG_FILE: path.join(temporaryRoot, "config.yaml"),
  DATA_DIRECTORY: dataDirectory,
  DATABASE_URL: `file:${path.join(dataDirectory, "system-tests.db")}?connection_limit=1`,
  NODE_ENV: "test",
};

let server;
try {
  await requireSuccess(
    startCommand(
      "SQLite database initialization",
      "node",
      ["scripts/ensure-sqlite-database.mjs"],
      { env },
    ),
  );
  await requireSuccess(
    startCommand(
      "Prisma migration deployment",
      "prisma",
      ["migrate", "deploy"],
      { env },
    ),
  );
  await requireSuccess(
    startCommand("Prisma configuration seed", "prisma", ["db", "seed"], {
      env,
    }),
  );

  server = startCommand("Nest backend", "nest", ["start"], {
    env,
    detached: process.platform !== "win32",
  });
  await waitForBackend(server, env);
  await runSystemTests(server);
} finally {
  await stopCommand(server);
  await rm(temporaryRoot, { recursive: true, force: true });
}
