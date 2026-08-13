import { defineConfig, configDefaults } from "vitest/config";

// The ONLY reason this file exists: vitest's default include pattern
// (**/*.{test,spec}.*) also matches the Playwright journey suite in
// tests/e2e/*.spec.ts, and @playwright/test throws the moment vitest
// imports one ("did not expect test.describe() to be called here").
// Everything else stays on vitest defaults on purpose - the unit suite
// was authored against them.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "tests/e2e/**"],
  },
});
