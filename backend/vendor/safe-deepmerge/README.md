# Prototype-safe deepmerge

This local package replaces `deepmerge`. The upstream advisory
[GHSA-gcqx-w48m-w2h4](https://github.com/advisories/GHSA-gcqx-w48m-w2h4)
covers every release from 4.2.0 to 4.3.1, the latest one, and has no patched
release as of October 28, 2026. Earlier releases lack even the partial key
check of 4.2.0, so downgrading would not repair `mergeObject()`.

Upstream assigns every merged key to the result. A `__proto__` key, held as a
plain property by an object from `JSON.parse` or `Object.create(null)`,
therefore replaces the prototype of the returned object. This implementation
never merges that key and defines every other key as an own data property, so
a result always keeps `Object.prototype` or `Array.prototype` and no setter is
reached.

It keeps the deepmerge 4 interface: `deepmerge(target, source, options)` and
`deepmerge.all(objects, options)`, with the `clone`, `arrayMerge`,
`isMergeableObject` and `customMerge` options and the
`cloneUnlessOtherwiseSpecified` helper passed to `arrayMerge`. The caller's
options object is no longer modified. Inherited and non-enumerable target
keys are skipped as in 4.3.1.

The installed consumers are `fork-ts-checker-webpack-plugin`, which merges
its own options during the backend build, and `@svgr/plugin-svgo`, which
declares the package without importing it. The tests check ordinary merges
against the results of upstream 4.3.1 and reject the poisoning vectors.

The manifest uses a direct local dependency and the `$deepmerge` override so
npm resolves the path from this project. Keep `vendor/` with the manifest and
lock file in CI and Docker build contexts. Revisit the replacement when
upstream publishes a verified fix.
