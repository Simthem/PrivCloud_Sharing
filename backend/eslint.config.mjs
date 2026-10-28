import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  eslintConfigPrettier,
  {
    files: ["src/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-require-imports": "off",
      "no-control-regex": "off",
      "no-useless-escape": "off",
    },
  },
  {
    // Test doubles name the parameters they ignore with a leading underscore.
    files: ["test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // Standalone Node.js test scripts.
    files: ["test/**/*.cjs", "test/**/*.mjs"],
    languageOptions: {
      globals: Object.fromEntries(
        [
          "AbortSignal",
          "Buffer",
          "Headers",
          "URL",
          "__dirname",
          "clearTimeout",
          "console",
          "fetch",
          "module",
          "process",
          "require",
          "setTimeout",
        ].map((name) => [name, "readonly"]),
      ),
    },
  },
  {
    files: ["test/**/*.cjs"],
    languageOptions: { sourceType: "commonjs" },
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  {
    ignores: ["dist/", "node_modules/", "prisma/"],
  },
);
