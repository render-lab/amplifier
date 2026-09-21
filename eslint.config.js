import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "coverage/"] },
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      // tsconfig.test.json is the wider of the two projects: it covers src,
      // test and scripts, so one project types every linted file.
      parserOptions: {
        project: ["./tsconfig.test.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "no-console": "error",
      // A leading underscore marks a parameter a signature requires but the
      // body ignores, such as the TaskContext every task handler is handed.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // src/log.ts is the console sink the rule points everything else at. The
    // scripts are local dev tools whose output is the point.
    files: ["src/log.ts", "scripts/**/*.ts"],
    rules: { "no-console": "off" },
  },
  {
    // Test doubles stand in for vendor payloads, so they hold `any` by nature
    // and satisfy async signatures with synchronous bodies.
    files: ["test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/unbound-method": "off",
    },
  },
  {
    // The config files sit outside both tsconfigs, so there is no type
    // information to lint them against.
    files: ["*.config.js", "*.config.ts"],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
