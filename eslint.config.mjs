import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "out/", "node_modules/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts", "tests/**/*.ts"],
    languageOptions: { globals: globals.browser },
    rules: {
      // Not available on Chromium 63 (Tizen 5.0).
      "no-restricted-properties": [
        "error",
        { property: "replaceChildren", message: "Chromium 86+. Use clear() from ui/dom." },
        { property: "replaceAll", message: "Chromium 85+. Use split/join or a global regex." },
        { property: "flat", message: "Chromium 69+." },
        { property: "flatMap", message: "Chromium 69+." },
        { property: "fromEntries", message: "Chromium 73+." },
        { property: "allSettled", message: "Chromium 76+." },
      ],
      "no-restricted-globals": [
        "error",
        { name: "globalThis", message: "Chromium 71+. Use window." },
        { name: "AbortController", message: "Chromium 66+. Use XHR abort()." },
        { name: "ResizeObserver", message: "Chromium 64+." },
      ],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["tools/**/*.mjs", "dev/**/*.mjs", "*.mjs"],
    languageOptions: { globals: globals.node },
  },
);
