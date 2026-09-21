import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // Both are process entry points: main.ts only imports the task modules
      // so the registry is populated, and webhook-server.ts binds the port.
      // Neither holds logic a unit test can reach.
      exclude: ["src/main.ts", "src/webhook-server.ts"],
      reporter: ["text", "html"],
      // Set just under the suite's current numbers, so a change that drops
      // coverage fails CI without the thresholds needing an edit per commit.
      thresholds: { statements: 90, branches: 85, functions: 90, lines: 90 },
    },
  },
});
