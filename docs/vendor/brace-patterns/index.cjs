"use strict";

const fillRange = require("fill-range");
const MAX_LENGTH = 65_536;
const MAX_DEPTH = 32;
const MAX_GROUPS = 128;
const MAX_EXPANSIONS = 1_000;
const MAX_OUTPUT_BYTES = 1_048_576;

function limit() {
  throw Object.assign(new Error("Brace pattern exceeds resource limits"), {
    code: "ERR_BRACE_PATTERN_LIMIT",
  });
}

// Build a small tree iteratively. Quotes, escapes and bracket expressions keep
// their literal braces, so only syntactic brace depth consumes the budget.
function parse(pattern, options = {}) {
  if (typeof pattern !== "string") throw new TypeError("Expected a string");
  if (pattern.length > MAX_LENGTH) limit();
  const root = { type: "root", pattern, arms: [[]], closed: true };
  const stack = [root];
  let quote = null,
    bracket = false,
    groups = 0;
  const append = (value) => {
    const arm = stack.at(-1).arms.at(-1);
    if (typeof value === "string" && typeof arm.at(-1) === "string")
      arm[arm.length - 1] += value;
    else arm.push(value);
  };
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === "\\") {
      append((options.keepEscaping ? char : "") + (pattern[++i] || ""));
      continue;
    }
    if (quote) {
      if (char === quote) {
        if (options.keepQuotes) append(char);
        quote = null;
      } else append(char);
      continue;
    }
    if (["'", '"', "`"].includes(char)) {
      quote = char;
      if (options.keepQuotes) append(char);
      continue;
    }
    if (char === "[") bracket = true;
    if (bracket) {
      append(char);
      if (char === "]") bracket = false;
      continue;
    }
    if (char === "{") {
      if (++groups > MAX_GROUPS || stack.length > MAX_DEPTH) limit();
      const node = {
        type: "brace",
        arms: [[]],
        closed: false,
        dollar: stack.at(-1).dollar || pattern[i - 1] === "$",
      };
      append(node);
      stack.push(node);
    } else if (char === "}" && stack.length > 1) {
      stack.pop().closed = true;
    } else if (char === "," && stack.length > 1) stack.at(-1).arms.push([]);
    else append(char);
  }
  return root;
}

function rangeParts(value, options) {
  const parts = /^(-?\d+|[A-Za-z])\.\.(-?\d+|[A-Za-z])(?:\.\.(-?\d+))?$/.exec(
    value,
  );
  if (!parts) return null;
  const step = Math.abs(Number(parts[3] ?? options.step ?? 1)) || 1;
  const numeric = /^-?\d+$/.test(parts[1]) && /^-?\d+$/.test(parts[2]);
  // Mixed numeric/alphabetic bounds are literal braces in the original API.
  if (/^-?\d+$/.test(parts[1]) !== /^-?\d+$/.test(parts[2])) return null;
  const start = numeric ? Number(parts[1]) : parts[1].charCodeAt(0);
  const end = numeric ? Number(parts[2]) : parts[2].charCodeAt(0);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    !Number.isSafeInteger(step)
  )
    limit();
  return {
    start: parts[1],
    end: parts[2],
    step,
    count: Math.floor(Math.abs(end - start) / step) + 1,
  };
}

function render(ast, options = {}, literal = false) {
  // ASTs only come from our parser. Caller-supplied ASTs must not reintroduce
  // cycles, deep recursion or unbounded work through another public entrypoint.
  const root =
    typeof ast === "string"
      ? parse(ast, options)
      : parse(ast?.pattern, options);
  const pending = [[root, false]],
    rendered = new Map();
  let bytes = 0;
  while (pending.length) {
    const [node, visited] = pending.pop();
    if (!visited) {
      pending.push([node, true]);
      for (const arm of node.arms)
        for (const child of arm)
          if (typeof child !== "string") pending.push([child, false]);
      continue;
    }
    const arms = node.arms.map((arm) =>
      arm
        .map((child) =>
          typeof child === "string" ? child : rendered.get(child),
        )
        .join(""),
    );
    let output;
    if (node.type === "root") output = arms.join(",");
    else if (!literal && node.closed && !node.dollar && arms.length > 1) {
      // Consecutive commas compile to one separator, while expansion preserves
      // the empty alternatives. Leading and trailing empty arms remain valid.
      output = `(${arms.filter((arm, i) => arm || i === 0 || i === arms.length - 1).join("|")})`;
    } else {
      const range =
        !literal && node.closed && !node.dollar && arms.length === 1
          ? rangeParts(arms[0], options)
          : null;
      if (range) {
        // Non-unit steps expand to alternatives inside fill-range.
        if (range.step > 1 && range.count > MAX_EXPANSIONS) limit();
        const value = fillRange(range.start, range.end, range.step, {
          ...options,
          wrap: false,
          toRegex: true,
          strictZeros: true,
        });
        output = value.length > 1 ? `(${value})` : value;
      } else {
        const opening = options.escapeInvalid && !literal ? "\\{" : "{";
        const closing = node.closed
          ? options.escapeInvalid && !literal
            ? "\\}"
            : "}"
          : "";
        output = opening + arms.join(",") + closing;
      }
    }
    bytes += output.length;
    if (bytes > MAX_OUTPUT_BYTES) limit();
    rendered.set(node, output);
  }
  return rendered.get(root);
}

function expandPattern(input, options = {}) {
  const parsed =
    typeof input === "string"
      ? parse(input, options)
      : parse(input?.pattern, options);
  const max =
    options.rangeLimit === undefined || options.rangeLimit === false
      ? MAX_EXPANSIONS
      : Math.min(MAX_EXPANSIONS, Math.max(1, Number(options.rangeLimit)));
  if (!Number.isSafeInteger(max)) limit();
  const pending = [[parsed, false]],
    expanded = new Map();
  let bytes = 0;
  const account = (items) => {
    if (items.length > max) limit();
    bytes += items.reduce((n, item) => n + item.length, 0);
    if (bytes > MAX_OUTPUT_BYTES) limit();
    return items;
  };
  const product = (left, right) => {
    if (left.length * right.length > max) limit();
    const output = [];
    for (const prefix of left)
      for (const suffix of right) {
        if (prefix.length + suffix.length + bytes > MAX_OUTPUT_BYTES) limit();
        output.push(prefix + suffix);
        bytes += prefix.length + suffix.length;
      }
    return output;
  };
  while (pending.length) {
    const [node, visited] = pending.pop();
    if (!visited) {
      pending.push([node, true]);
      for (const arm of node.arms)
        for (const child of arm)
          if (typeof child !== "string") pending.push([child, false]);
      continue;
    }
    const arms = node.arms.map((arm) =>
      arm.reduce(
        (items, child) =>
          product(
            items,
            typeof child === "string" ? [child] : expanded.get(child),
          ),
        [""],
      ),
    );
    let output;
    if (
      node.closed &&
      !node.dollar &&
      (node.type === "root" || arms.length > 1)
    ) {
      output = account(arms.flat());
    } else {
      let values = arms[0];
      for (let i = 1; i < arms.length; i++)
        values = product(product(values, [","]), arms[i]);
      const range =
        node.closed && !node.dollar && values.length === 1
          ? rangeParts(values[0], options)
          : null;
      if (range) {
        // Check range size before fill-range allocates anything. rangeLimit:false
        // never disables the hard product/output bounds.
        if (range.count > max) limit();
        output = account(
          fillRange(range.start, range.end, range.step, {
            ...options,
            toRegex: false,
          }),
        );
      } else
        output = account(
          values.map((value) => "{" + value + (node.closed ? "}" : "")),
        );
    }
    expanded.set(node, output);
  }
  let result = expanded.get(parsed);
  if (options.noempty) result = result.filter(Boolean);
  if (options.nodupes) result = [...new Set(result)];
  return result;
}

function braces(input, options = {}) {
  const patterns = Array.isArray(input) ? input : [input];
  if (patterns.length > MAX_EXPANSIONS) limit();
  const result = [];
  for (const pattern of patterns) {
    const created = braces.create(pattern, options);
    result.push(...[].concat(created));
    if (
      result.length > MAX_EXPANSIONS ||
      result.reduce((n, item) => n + item.length, 0) > MAX_OUTPUT_BYTES
    )
      limit();
  }
  return options.expand && options.nodupes ? [...new Set(result)] : result;
}

braces.parse = parse;
braces.stringify = (input, options) => render(input, options, true);
braces.compile = render;
braces.expand = expandPattern;
braces.create = (pattern, options = {}) => {
  if (typeof pattern !== "string") throw new TypeError("Expected a string");
  if (pattern.length < 3) return [pattern];
  return options.expand
    ? expandPattern(pattern, options)
    : render(pattern, options);
};
module.exports = braces;
