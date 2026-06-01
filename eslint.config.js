import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // Skip build output, Node-context config files (they use process/__dirname/require), and dead
  // backup copies of AmbientViewerPage.
  { ignores: ["dist", "**/*.config.js", "**/*copy*.jsx", "**/*_REFERENCE.jsx"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx,js,jsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      "@typescript-eslint/no-unused-vars": "off",
      // The codebase uses intentional best-effort `catch (_) {}` cleanups (e.g. video.pause()).
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
);
