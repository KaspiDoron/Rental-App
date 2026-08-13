import path from "node:path";
import { defineConfig, configDefaults } from "vitest/config";

// Two deliberate deviations from vitest defaults; everything else stays on
// them on purpose - the unit suite was authored against them.
//
// 1. exclude tests/e2e: vitest's default include (**/*.{test,spec}.*) also
//    matches the Playwright journey suite, and @playwright/test throws the
//    moment vitest imports one.
// 2. aliases: "server-only" resolves to the same no-op shim the gateway and
//    workers use (the real package throws outside Next), and "@" resolves to
//    src so tests can import server modules directly. vi.doMock("@/lib/...")
//    calls still intercept by specifier exactly as before - the alias only
//    gives UNMOCKED "@/..." imports somewhere real to land.
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "server-only": path.resolve(__dirname, "shims/server-only.ts"),
    },
  },
  test: {
    exclude: [...configDefaults.exclude, "tests/e2e/**"],
  },
});
