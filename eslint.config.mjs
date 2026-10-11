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
    files: ["**/*.cjs"],
    languageOptions: { globals: globals.node, sourceType: "commonjs" },
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      // Companion namespaces holding a class's related types are the house style.
      "@typescript-eslint/no-namespace": "off",
      // So are typed events: a class merged with an interface of emit/on overloads.
      "@typescript-eslint/no-unsafe-declaration-merging": "off",
    },
  },
);
