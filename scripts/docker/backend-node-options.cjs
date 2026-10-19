"use strict";

const { resolve } = require("node:path");

const PROXY_BOOTSTRAP = "/opt/app/backend/global-agent-bootstrap.js";
const LEGACY_GLOBAL_AGENT_PRELOAD =
  /(^|\s)(?:--require|-r)(?:=|\s+)(?:["']?)(?:(?:\/opt\/app\/backend\/)|(?:\.\/))?node_modules\/global-agent\/bootstrap(?:\.js)?(?:["']?)(?=\s|$)/g;

function stripLegacyGlobalAgentPreloads(options) {
  return options.replace(LEGACY_GLOBAL_AGENT_PRELOAD, "$1").trim();
}

function backendNodeOptions(
  environment = process.env,
  backendDirectory = "/opt/app/backend",
) {
  const bootstrap = resolve(backendDirectory, "global-agent-bootstrap.js");
  let options = stripLegacyGlobalAgentPreloads(environment.NODE_OPTIONS || "");
  if (!options.includes("--dns-result-order=")) {
    options =
      `--dns-result-order=${environment.NODE_DNS_RESULT_ORDER || "ipv4first"}` +
      (options ? ` ${options}` : "");
  }
  options += ` --require ${JSON.stringify(bootstrap)}`;
  return (
    `--max-old-space-size=${environment.NODE_MAX_OLD_SPACE_SIZE || "3072"} ` +
    options.trim()
  );
}

module.exports = {
  PROXY_BOOTSTRAP,
  backendNodeOptions,
  stripLegacyGlobalAgentPreloads,
};
