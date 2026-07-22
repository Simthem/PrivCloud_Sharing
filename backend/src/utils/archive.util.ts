import archiver = require("archiver");

type ArchiverV8Module = {
  ZipArchive: new (
    options?: archiver.ArchiverOptions,
  ) => archiver.Archiver;
};

const { ZipArchive } = archiver as unknown as ArchiverV8Module;

/**
 * Archiver 8 is ESM-only and exposes archive classes instead of the historical
 * default factory. Keep that runtime boundary in one place while DefinitelyTyped
 * catches up with the v8 named exports.
 */
export function createZipArchive(
  options?: archiver.ArchiverOptions,
): archiver.Archiver {
  return new ZipArchive(options);
}
