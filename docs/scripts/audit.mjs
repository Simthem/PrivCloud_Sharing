import { spawnSync } from "node:child_process";

// Every known advisory fails the build, none is accepted.
const result = spawnSync("npm", ["audit"], { stdio: "inherit" });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
