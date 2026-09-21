import fs from "node:fs";

/** The app imports its own modules without an extension, the way the bundler
 *  resolves them. Teach node:test the same rule so utils can be unit tested. */
export async function resolve(specifier, context, next) {
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
