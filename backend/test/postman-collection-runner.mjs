/**
 * Minimal Postman collection runner.
 *
 * Replaces `newman` as the system test driver. Newman pulls in the `postman-*`
 * tree, which pins `@faker-js/faker@5.5.3` (GHSA-qxc2-j82w-r537) with no fixed
 * release available upstream, so the runner only implements the slice of the
 * Postman sandbox that `test/system-tests.postman_collection.json` actually uses:
 *
 *   - `{{variable}}` interpolation in urls, headers and raw bodies
 *   - `:pathVariable` substitution from `request.url.variable`
 *   - raw request bodies (with the implicit JSON content type)
 *   - `pm.test`, `pm.expect`, `pm.response` and `pm.collectionVariables`
 *   - collection/folder/item level `prerequest` and `test` scripts
 *
 * Anything outside that subset (dynamic variables, form bodies, `pm.sendRequest`,
 * ...) is intentionally unsupported and reported as an error instead of being
 * silently ignored.
 */

import { readFile } from "node:fs/promises";

const REQUEST_TIMEOUT_MS = 60_000;

class AssertionError extends Error {
  constructor(message) {
    super(message);
    this.name = "AssertionError";
  }
}

const CHAINS = [
  "to",
  "be",
  "been",
  "is",
  "that",
  "which",
  "and",
  "has",
  "have",
  "with",
  "at",
  "of",
];

function describe(value) {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "bigint") return `${value}n`;
  if (value === undefined) return "undefined";
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function withChains(target, factory) {
  for (const chain of CHAINS) {
    Object.defineProperty(target, chain, { get: () => target });
  }
  Object.defineProperty(target, "not", { get: factory });
  return target;
}

function createExpectation(actual, negated = false) {
  const check = (passed, message, negatedMessage) => {
    if (negated ? passed : !passed) {
      throw new AssertionError(negated ? negatedMessage : message);
    }
    return expectation;
  };

  const expectation = {
    property(name) {
      return check(
        actual !== null &&
          actual !== undefined &&
          Object.prototype.hasOwnProperty.call(Object(actual), name),
        `expected ${describe(actual)} to have property ${describe(name)}`,
        `expected ${describe(actual)} to not have property ${describe(name)}`,
      );
    },
    include(value) {
      const contained =
        typeof actual === "string"
          ? actual.includes(value)
          : Array.isArray(actual)
            ? actual.includes(value)
            : false;
      return check(
        contained,
        `expected ${describe(actual)} to include ${describe(value)}`,
        `expected ${describe(actual)} to not include ${describe(value)}`,
      );
    },
    equal(value) {
      return check(
        actual === value,
        `expected ${describe(actual)} to equal ${describe(value)}`,
        `expected ${describe(actual)} to not equal ${describe(value)}`,
      );
    },
    eql(value) {
      return check(
        JSON.stringify(actual) === JSON.stringify(value),
        `expected ${describe(actual)} to deeply equal ${describe(value)}`,
        `expected ${describe(actual)} to not deeply equal ${describe(value)}`,
      );
    },
    a(type) {
      return check(
        typeof actual === type,
        `expected ${describe(actual)} to be a ${type}`,
        `expected ${describe(actual)} to not be a ${type}`,
      );
    },
  };
  expectation.equals = expectation.equal;
  expectation.an = expectation.a;
  expectation.contain = expectation.include;

  return withChains(expectation, () => createExpectation(actual, !negated));
}

function createResponseAssertion(response, negated = false) {
  const assertion = {
    status(expected) {
      const passed = response.code === expected;
      if (negated ? passed : !passed) {
        throw new AssertionError(
          negated
            ? `expected response to not have status ${expected}`
            : `expected response to have status ${expected} but got ${response.code}`,
        );
      }
      return assertion;
    },
    header(name) {
      const passed = response.headers.get(name) !== undefined;
      if (negated ? passed : !passed) {
        throw new AssertionError(
          `expected response to ${negated ? "not " : ""}have header ${describe(name)}`,
        );
      }
      return assertion;
    },
  };

  return withChains(assertion, () =>
    createResponseAssertion(response, !negated),
  );
}

function createResponse(raw) {
  const decode = () => raw.body.toString("utf8");

  const response = {
    code: raw.status,
    status: raw.statusText,
    responseTime: raw.responseTime,
    stream: raw.body,
    text: decode,
    json() {
      try {
        return JSON.parse(decode());
      } catch (error) {
        throw new AssertionError(
          `response body is not valid JSON: ${error.message}`,
        );
      }
    },
    headers: {
      all: () => raw.headers.map(([key, value]) => ({ key, value })),
      get(name) {
        const match = raw.headers.find(
          ([key]) => key.toLowerCase() === name.toLowerCase(),
        );
        return match?.[1];
      },
      has(name) {
        return response.headers.get(name) !== undefined;
      },
    },
  };

  Object.defineProperty(response, "to", {
    get: () => createResponseAssertion(response),
  });
  return response;
}

function interpolate(value, variables) {
  if (typeof value !== "string") return value;
  return value.replace(/\{\{([^{}\s]+)\}\}/g, (match, name) => {
    if (!variables.has(name)) return match;
    const replacement = variables.get(name);
    return replacement === undefined || replacement === null
      ? ""
      : String(replacement);
  });
}

function buildUrl(request, variables) {
  const url = request.url;
  if (typeof url === "string") return interpolate(url, variables);
  if (!url?.raw) {
    throw new Error("request has no url.raw, which the runner requires");
  }

  let resolved = interpolate(url.raw, variables);
  for (const pathVariable of url.variable ?? []) {
    const value = encodeURIComponent(
      interpolate(String(pathVariable.value ?? ""), variables),
    );
    resolved = resolved.replace(
      new RegExp(`:${pathVariable.key}(?![A-Za-z0-9_])`, "g"),
      value,
    );
  }

  const unresolved = resolved.match(/\{\{[^{}\s]+\}\}/g);
  if (unresolved) {
    throw new Error(`unresolved variables in url: ${unresolved.join(", ")}`);
  }
  return resolved;
}

function createRequestHeaders(entries) {
  const headers = entries.slice();
  const indexOf = (key) =>
    headers.findIndex(
      (header) => header.key.toLowerCase() === key.toLowerCase(),
    );

  return {
    entries: headers,
    all: () => headers.slice(),
    get(key) {
      const index = indexOf(key);
      return index === -1 ? undefined : headers[index].value;
    },
    has(key) {
      return indexOf(key) !== -1;
    },
    add(header) {
      headers.push({ key: header.key, value: String(header.value) });
    },
    upsert(header) {
      const index = indexOf(header.key);
      const next = { key: header.key, value: String(header.value) };
      if (index === -1) headers.push(next);
      else headers[index] = next;
    },
    remove(key) {
      const index = indexOf(key);
      if (index !== -1) headers.splice(index, 1);
    },
  };
}

function buildRequest(item, variables) {
  const source = item.request;
  const headerEntries = (source.header ?? [])
    .filter((header) => !header.disabled)
    .map((header) => ({
      key: header.key,
      value: interpolate(String(header.value ?? ""), variables),
    }));

  let body;
  if (source.body && source.body.mode !== undefined) {
    if (source.body.mode !== "raw") {
      throw new Error(
        `unsupported request body mode "${source.body.mode}" (only "raw" is implemented)`,
      );
    }
    body = interpolate(source.body.raw ?? "", variables);
    if (source.body.options?.raw?.language === "json") {
      const hasContentType = headerEntries.some(
        (header) => header.key.toLowerCase() === "content-type",
      );
      if (!hasContentType) {
        headerEntries.push({ key: "Content-Type", value: "application/json" });
      }
    }
  }

  return {
    method: (source.method ?? "GET").toUpperCase(),
    url: buildUrl(source, variables),
    headers: createRequestHeaders(headerEntries),
    body,
  };
}

async function sendRequest(request) {
  const started = Date.now();
  const headers = new Headers();
  for (const header of request.headers.all()) {
    headers.append(header.key, header.value);
  }

  const response = await fetch(request.url, {
    method: request.method,
    headers,
    body: request.body,
    redirect: "follow",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const collected = [];
  for (const [key, value] of response.headers) {
    if (key.toLowerCase() === "set-cookie") continue;
    collected.push([key, value]);
  }
  for (const cookie of response.headers.getSetCookie()) {
    collected.push(["set-cookie", cookie]);
  }

  return {
    status: response.status,
    statusText: response.statusText,
    headers: collected,
    body: Buffer.from(await response.arrayBuffer()),
    responseTime: Date.now() - started,
  };
}

function scriptSource(event) {
  const exec = event?.script?.exec;
  if (Array.isArray(exec)) return exec.join("\n");
  return typeof exec === "string" ? exec : "";
}

function collectScripts(nodes, listen) {
  return nodes
    .flatMap((node) => node.event ?? [])
    .filter((event) => event.listen === listen)
    .map(scriptSource)
    .filter((source) => source.trim() !== "");
}

function flatten(items, path = []) {
  return items.flatMap((item) =>
    item.item
      ? flatten(item.item, [...path, item])
      : [{ item, ancestors: path }],
  );
}

function createVariableScope(variables) {
  return {
    get: (key) => variables.get(key),
    set: (key, value) => variables.set(key, value),
    has: (key) => variables.has(key),
    unset: (key) => variables.delete(key),
    clear: () => variables.clear(),
    toObject: () => Object.fromEntries(variables),
  };
}

export async function runCollection(collectionPath, options = {}) {
  const log = options.log ?? console.log;
  const collection = JSON.parse(await readFile(collectionPath, "utf8"));
  const variables = new Map(
    (collection.variable ?? []).map((variable) => [
      variable.key,
      variable.value,
    ]),
  );
  for (const [key, value] of Object.entries(options.variables ?? {})) {
    variables.set(key, value);
  }

  const scope = createVariableScope(variables);
  const summary = { requests: 0, assertions: 0, failures: [] };

  log(`\n${collection.info?.name ?? collectionPath}\n`);

  for (const { item, ancestors } of flatten(collection.item ?? [])) {
    const chain = [collection, ...ancestors, item];
    const label = [...ancestors, item].map((node) => node.name).join(" / ");
    summary.requests += 1;

    const fail = (name, error) => {
      summary.failures.push({ request: label, name, error });
      log(`  ✗ ${label} › ${name}: ${error.message}`);
    };

    const pm = {
      collectionVariables: scope,
      variables: scope,
      environment: scope,
      globals: scope,
      expect: (value) => createExpectation(value),
      test(name, callback) {
        summary.assertions += 1;
        try {
          callback();
        } catch (error) {
          fail(name, error);
        }
      },
    };

    const runScripts = (sources, phase) => {
      for (const source of sources) {
        try {
          // eslint-disable-next-line no-new-func
          new Function("pm", `"use strict";\n${source}`)(pm);
        } catch (error) {
          summary.assertions += 1;
          fail(`${phase} script`, error);
        }
      }
    };

    let request;
    try {
      request = buildRequest(item, variables);
    } catch (error) {
      summary.assertions += 1;
      fail("request", error);
      continue;
    }
    pm.request = request;

    runScripts(collectScripts(chain, "prerequest"), "prerequest");

    let response;
    try {
      response = createResponse(await sendRequest(request));
    } catch (error) {
      summary.assertions += 1;
      fail("request", error);
      continue;
    }
    pm.response = response;

    log(`  ${request.method} ${request.url} → ${response.code} [${label}]`);
    runScripts(collectScripts(chain, "test"), "test");
  }

  log(
    `\n${summary.requests} requests, ${summary.assertions} assertions, ${summary.failures.length} failed\n`,
  );
  return summary;
}
