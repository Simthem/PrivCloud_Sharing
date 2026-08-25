"use strict";

// global-agent reads its configuration exactly once, while the preload is
// evaluated. Normalize the environment before requiring it so launches outside
// Docker Compose get the same safe behaviour as the production entrypoint.
const environment = process.env;
const hasExplicitForceSetting = Object.prototype.hasOwnProperty.call(
  environment,
  "GLOBAL_AGENT_FORCE_GLOBAL_AGENT",
);

if (!hasExplicitForceSetting) {
  // Preserve explicit agents (notably the S3 keep-alive proxy pool). Requests
  // without an agent still use global-agent, so OAuth and other integrations
  // continue to honor the forward proxy.
  environment.GLOBAL_AGENT_FORCE_GLOBAL_AGENT = "false";
}

const genericHttpProxy = environment.HTTP_PROXY || environment.http_proxy;
const genericHttpsProxy = environment.HTTPS_PROXY || environment.https_proxy;

if (!environment.GLOBAL_AGENT_HTTP_PROXY) {
  environment.GLOBAL_AGENT_HTTP_PROXY =
    genericHttpProxy ||
    genericHttpsProxy ||
    environment.GLOBAL_AGENT_HTTPS_PROXY ||
    "";
}
if (!environment.GLOBAL_AGENT_HTTPS_PROXY) {
  environment.GLOBAL_AGENT_HTTPS_PROXY =
    genericHttpsProxy ||
    genericHttpProxy ||
    environment.GLOBAL_AGENT_HTTP_PROXY ||
    "";
}

const normalizedForce = (environment.GLOBAL_AGENT_FORCE_GLOBAL_AGENT || "")
  .trim()
  .toLowerCase();
const overrideRisk = normalizedForce !== "false";
const proxyMode = environment.GLOBAL_AGENT_HTTPS_PROXY
  ? environment.GLOBAL_AGENT_HTTP_PROXY
    ? "http+https"
    : "https-only"
  : environment.GLOBAL_AGENT_HTTP_PROXY
    ? "http-only"
    : "none";

// Deliberately log presence/mode only. Proxy URLs may contain credentials.
const message =
  `[proxy-bootstrap] proxy=${proxyMode} ` +
  `forceGlobalAgent=${normalizedForce || "invalid"} ` +
  `source=${hasExplicitForceSetting ? "explicit" : "safe-default"} ` +
  `overrideRisk=${overrideRisk}`;
if (overrideRisk) {
  console.warn(message);
} else {
  // Keep stdout machine-readable: Next.js parses the JSON emitted by
  // `tsc --showConfig` during its build and inherits this preload.
  console.error(message);
}

require("global-agent/bootstrap");
