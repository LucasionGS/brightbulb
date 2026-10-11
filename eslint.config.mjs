import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default tseslint.config(
  { ignores: [".vite/", "out/", "dist-test/", "node_modules/", ".venv/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/renderer/**/*.{ts,tsx}", "src/capture/**/*.ts"],
    plugins: { "react-hooks": reactHooks },
    languageOptions: { globals: globals.browser },
    rules: reactHooks.configs.recommended.rules,
  },
  {
    files: ["src/main/**/*.ts", "src/sync/**/*.ts", "src/preload/**/*.ts", "scripts/**/*.ts", "test/**/*.ts", "*.mts"],
    languageOptions: { globals: globals.node },
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      // Companion namespaces holding a class's related types are the house style.
      "@typescript-eslint/no-namespace": "off",
    },
  },
);
