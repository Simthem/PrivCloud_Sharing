import { dirname } from "path";
import { fileURLToPath } from "url";
import nextPlugin from "@next/eslint-plugin-next";
import reactHooksPlugin from "eslint-plugin-react-hooks";
import tsParser from "@typescript-eslint/parser";
import eslintConfigPrettier from "eslint-config-prettier";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// The legacy eslint-plugin-react package still depends on minimatch 3 and its
// vulnerable brace-expansion chain. This focused replacement preserves the
// only enabled React rule without pulling that dependency graph into CI.
const reactSecurityPlugin = {
  rules: {
    "no-danger": {
      meta: {
        type: "problem",
        schema: [],
        messages: {
          dangerousProp: "Dangerous property '{{name}}' found",
        },
      },
      create(context) {
        return {
          JSXAttribute(node) {
            const element = node.parent?.name;
            const isDomElement =
              element?.type === "JSXIdentifier" && /^[a-z]/.test(element.name);

            if (
              isDomElement &&
              node.name?.type === "JSXIdentifier" &&
              node.name.name === "dangerouslySetInnerHTML"
            ) {
              context.report({
                node,
                messageId: "dangerousProp",
                data: { name: node.name.name },
              });
            }
          },
        };
      },
    },
  },
};

export default [
  {
    ignores: ["**/*.d.ts", ".next/**", "node_modules/**"],
  },
  {
    files: ["**/*.{ts,tsx,js,jsx}"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        ecmaFeatures: { jsx: true },
        project: null,
      },
      globals: {
        React: "readonly",
        RequestInit: "readonly",
        BlobPart: "readonly",
        FileSystemFileHandle: "readonly",
        FileSystemWritableFileStream: "readonly",
        FileSystemWriteChunkType: "readonly",
        WakeLockSentinel: "readonly",
        PermissionName: "readonly",
        NotificationPermission: "readonly",
        PublicKeyCredential: "readonly",
        AuthenticationExtensionsClientInputs: "readonly",
        ILocale: "readonly",
        // Browser globals
        window: "readonly",
        document: "readonly",
        navigator: "readonly",
        fetch: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        console: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        FormData: "readonly",
        Blob: "readonly",
        File: "readonly",
        FileReader: "readonly",
        AbortController: "readonly",
        Headers: "readonly",
        Request: "readonly",
        Response: "readonly",
        crypto: "readonly",
        localStorage: "readonly",
        sessionStorage: "readonly",
        HTMLElement: "readonly",
        HTMLInputElement: "readonly",
        Event: "readonly",
        MouseEvent: "readonly",
        KeyboardEvent: "readonly",
        ClipboardEvent: "readonly",
        DragEvent: "readonly",
        process: "readonly",
        module: "readonly",
        require: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
      },
    },
    plugins: {
      "@next/next": nextPlugin,
      react: reactSecurityPlugin,
      "react-hooks": reactHooksPlugin,
    },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs["core-web-vitals"].rules,
      quotes: ["warn", "double", { allowTemplateLiterals: true }],
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@next/next/no-img-element": "off",
      // react-hooks/exhaustive-deps: demoted to warn so violations surface in CI
      // without breaking the build. Files with intentional empty deps arrays use
      // // eslint-disable-next-line react-hooks/exhaustive-deps inline comments.
      "react-hooks/exhaustive-deps": "warn",
      // react/no-danger: demoted to warn. All usages are JSON.stringify(ld+json)
      // (structured data for SEO) or trusted static server content.
      // Each site must be audited and suppressed inline where verified safe.
      "react/no-danger": "warn",
    },
  },
  eslintConfigPrettier,
];
