import fs from "node:fs";

/** The app imports its own modules without an extension, the way the bundler
 *  resolves them. Teach node:test the same rule so utils can be unit tested. */
export async function resolve(specifier, context, next) {
  // pdf.js asks Node.js for its legacy build. The bundle keeps the modern one.
  const resolved = await resolveWithExtension(
    specifier === "pdfjs-dist" ? "pdfjs-dist/legacy/build/pdf.mjs" : specifier,
    context,
    next,
  );
  // The app's TypeScript is made of ES modules, but frontend/package.json has
  // no "type" (next.config.js is CommonJS). Without a format Node parses each
  // file twice and warns with MODULE_TYPELESS_PACKAGE_JSON.
  if (
    resolved.format == null &&
    resolved.url.startsWith("file:") &&
    new URL(resolved.url).pathname.endsWith(".ts") &&
    !resolved.url.includes("/node_modules/")
  ) {
    return { ...resolved, format: "module-typescript" };
  }
  return resolved;
}

async function resolveWithExtension(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (error) {
    if (specifier.startsWith(".") && context.parentURL) {
      for (const extension of [".ts", ".tsx", "/index.ts"]) {
        if (fs.existsSync(new URL(specifier + extension, context.parentURL))) {
          return next(specifier + extension, context);
        }
      }
    }
    throw error;
  }
}
