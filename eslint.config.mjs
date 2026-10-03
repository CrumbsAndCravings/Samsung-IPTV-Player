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
      // Not available on the TV's Chromium 69 (Tizen 5.5).
      "no-restricted-properties": [
        "error",
        { property: "replaceChildren", message: "Chromium 86+. Use clear() from ui/dom." },
        { property: "replaceAll", message: "Chromium 85+. Use split/join or a global regex." },
        { property: "fromEntries", message: "Chromium 73+." },
        { property: "allSettled", message: "Chromium 76+." },
        { property: "matchAll", message: "Chromium 73+." },
      ],
      "no-restricted-globals": [
        "error",
        { name: "globalThis", message: "Chromium 71+. Use window." },
        { name: "queueMicrotask", message: "Chromium 71+." },
      ],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["tools/**/*.mjs", "dev/**/*.mjs", "helper/**/*.mjs", "*.mjs"],
    languageOptions: { globals: globals.node },
  },
);
