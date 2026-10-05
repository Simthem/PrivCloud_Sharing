# Bounded brace patterns

This local package replaces `braces` for the pattern compilation and expansion
used by micromatch, fast-glob and chokidar. The upstream advisory
[GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)
has no patched release as of October 3, 2026. Changing only the package name
or its reported version would not repair the original recursive parser.

This implementation builds and walks its own pattern tree iteratively. It
does not include the upstream `braces` parser, compiler or expander. Numeric
and alphabetic ranges use `fill-range`, with size checks before allocation.
It preserves the compilation and expansion behavior needed by the installed
consumers, including nested alternatives, empty alternatives, padded ranges,
escapes, quotes, bracket expressions and literal dollar braces.

Hard limits apply to every entry point: 65,536 input characters, 32 nested
brace groups, 128 total groups, 1,000 expansion results and 1 MiB of accumulated
intermediate output. Exceeding a limit throws `ERR_BRACE_PATTERN_LIMIT`, without
truncating results. `rangeLimit: false` cannot disable these limits. Very large
custom glob patterns must be split into smaller patterns.

The exported `parse`, `compile` and `stringify` helpers accept this package's
own tree format. They are not a general replacement for third-party code that
inspects the internal AST of upstream `braces`. No installed consumer does so.
The tests cover matching through micromatch and fast-glob, and reject nested
and combinatorial attacks in a time-limited process.

The manifest uses a direct local dependency and the `$braces` override so npm
resolves the path from this project. Keep `vendor/` with the manifest and lock
file in CI and Docker build contexts. Revisit the replacement when upstream
publishes a verified fix.
