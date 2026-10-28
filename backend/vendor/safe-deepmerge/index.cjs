"use strict";

// Assigning this key replaces the prototype of the receiving object.
const PROTOTYPE_KEY = "__proto__";
const REACT_ELEMENT = Symbol.for("react.element");

function isMergeableObject(value) {
  if (!value || typeof value !== "object") return false;
  const tag = Object.prototype.toString.call(value);
  return (
    tag !== "[object RegExp]" &&
    tag !== "[object Date]" &&
    value.$$typeof !== REACT_ELEMENT
  );
}

// Own enumerable string and symbol keys, without the prototype key that an
// object from JSON.parse or Object.create(null) can hold as a plain property.
function mergeableKeys(value) {
  return [
    ...Object.keys(value),
    ...Object.getOwnPropertySymbols(value).filter((symbol) =>
      Object.prototype.propertyIsEnumerable.call(value, symbol),
    ),
  ].filter((key) => key !== PROTOTYPE_KEY);
}

function hasProperty(value, key) {
  try {
    return key in value;
  } catch {
    return false;
  }
}

// A key the target only inherits, or holds as a non-enumerable property, is
// never merged into the result.
function isUnsafeKey(target, key) {
  return (
    hasProperty(target, key) &&
    !(
      Object.prototype.hasOwnProperty.call(target, key) &&
      Object.prototype.propertyIsEnumerable.call(target, key)
    )
  );
}

// Defining instead of assigning never reaches a setter of the result.
function define(destination, key, value) {
  Object.defineProperty(destination, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

function cloneUnlessOtherwiseSpecified(value, options) {
  return options.clone !== false && options.isMergeableObject(value)
    ? deepmerge(Array.isArray(value) ? [] : {}, value, options)
    : value;
}

function defaultArrayMerge(target, source, options) {
  return target
    .concat(source)
    .map((element) => cloneUnlessOtherwiseSpecified(element, options));
}

function mergeFunction(key, options) {
  const custom = options.customMerge ? options.customMerge(key) : undefined;
  return typeof custom === "function" ? custom : deepmerge;
}

function mergeObject(target, source, options) {
  const destination = {};
  if (options.isMergeableObject(target)) {
    for (const key of mergeableKeys(target))
      define(
        destination,
        key,
        cloneUnlessOtherwiseSpecified(target[key], options),
      );
  }
  for (const key of mergeableKeys(source)) {
    if (isUnsafeKey(target, key)) continue;
    define(
      destination,
      key,
      hasProperty(target, key) && options.isMergeableObject(source[key])
        ? mergeFunction(key, options)(target[key], source[key], options)
        : cloneUnlessOtherwiseSpecified(source[key], options),
    );
  }
  return destination;
}

function deepmerge(target, source, options = {}) {
  // A copy, so the caller's options object is never modified.
  const settings = {
    ...options,
    arrayMerge: options.arrayMerge || defaultArrayMerge,
    isMergeableObject: options.isMergeableObject || isMergeableObject,
    cloneUnlessOtherwiseSpecified,
  };
  const sourceIsArray = Array.isArray(source);
  if (sourceIsArray !== Array.isArray(target))
    return cloneUnlessOtherwiseSpecified(source, settings);
  return sourceIsArray
    ? settings.arrayMerge(target, source, settings)
    : mergeObject(target, source, settings);
}

deepmerge.all = (array, options) => {
  if (!Array.isArray(array))
    throw new Error("first argument should be an array");
  return array.reduce((merged, next) => deepmerge(merged, next, options), {});
};

module.exports = deepmerge;
