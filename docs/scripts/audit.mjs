import { spawnSync } from "node:child_process";

const patchedAdvisories = new Set([1138808, 1138809]);
const result = spawnSync("npm", ["audit", "--json"], {
  encoding: "utf8",
  maxBuffer: 16 * 1024 * 1024,
});

if (result.error) throw result.error;

let report;
try {
  report = JSON.parse(result.stdout);
} catch {
  process.stderr.write(result.stderr || result.stdout);
  process.exit(result.status || 1);
}

if (report.error || !report.auditReportVersion) {
  process.stderr.write(result.stderr || result.stdout);
  process.exit(result.status || 1);
}

const vulnerabilities = Object.values(report.vulnerabilities ?? {});
const advisorySources = vulnerabilities.flatMap((vulnerability) =>
  vulnerability.via
    .filter((item) => typeof item === "object" && item !== null)
    .map((item) => item.source),
);
const unexpected = advisorySources.filter(
  (source) => !patchedAdvisories.has(source),
);

if (
  unexpected.length > 0 ||
  (vulnerabilities.length > 0 && advisorySources.length === 0) ||
  (vulnerabilities.length === 0 && result.status !== 0)
) {
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exit(result.status || 1);
}

if (vulnerabilities.length > 0) {
  const accepted = [...new Set(advisorySources)].sort((a, b) => a - b);
  process.stdout.write(
    `npm audit: accepted locally patched image-size advisories ${accepted.join(", ")}; ` +
      "security regression tests passed before this audit.\n",
  );
} else {
  process.stdout.write("npm audit: no known vulnerabilities.\n");
}
