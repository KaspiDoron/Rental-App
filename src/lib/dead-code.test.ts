import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

// WAVE 4.2 - STAYS-DELETED ASSERTIONS.
//
// Every entry below was deleted with proof (a repo-wide `rg -w -l NAME`
// returning zero references outside the deleted cluster). A route that
// grows back silently re-opens the exact hole that got it deleted -
// /api/safety in particular was an UNAUTHENTICATED LLM-spend endpoint.
// If one of these fails, the file returned without its consumers: either
// wire it in for real or delete it again.

const ROOT = path.resolve(__dirname, "../..");

const DELETED = [
  // Orphan API routes (zero client references, zero cross-route imports).
  "src/app/api/safety", // unauthenticated LLM spend - the worst one
  "src/app/api/contact",
  "src/app/api/wa/health",
  "src/app/api/admin/funnel",
  "src/app/api/admin/orchestrator", // graph-era Pipeline Studio backend (+ /simulate)
  "src/app/api/admin/prompts",
  // Cascade of admin/funnel - its only importer.
  "src/lib/funnel.ts",
  // The graph-era Pipeline Studio UI - nothing outside the folder imported it.
  "src/components/studio",
  // Never imported by any runtime (`from "@wheeldeal/db"` had zero hits);
  // the GCP services talk PostgREST through @wheeldeal/core instead.
  "packages/db",
];

describe("dead code stays deleted", () => {
  for (const rel of DELETED) {
    it(`${rel} does not exist`, () => {
      expect(existsSync(path.join(ROOT, rel)), `${rel} came back`).toBe(false);
    });
  }

  // The survivors the sweep explicitly KEPT because the confirm-grep proved
  // them alive - documented so a future sweep does not re-litigate them.
  // THE GREP SCOPE THAT BIT US (deploy run #247): the 4.2 zero-reference
  // sweep covered src/packages/apps/services/scripts but NOT the build
  // artifacts - the Dockerfile still COPY'd packages/db/package.json and the
  // Docker build died in CI, three minutes after a fully green verify. Every
  // deleted cluster must be absent from the build/deploy surface too.
  const BUILD_SURFACE = ["Dockerfile", ".dockerignore", "render.yaml"];
  for (const rel of BUILD_SURFACE) {
    it(`${rel} references no deleted cluster`, () => {
      const body = readFileSync(path.join(ROOT, rel), "utf8");
      for (const dead of DELETED) {
        expect(body, `${rel} still references deleted ${dead}`).not.toContain(dead);
      }
    });
  }

  const KEPT = [
    "src/lib/spte/index.ts", // dynamically imported: engine-route.ts `await import("./spte")`
    "src/lib/simulate.ts", // ops golden replay (replayConversation)
    "src/lib/i18n-extras.ts", // already deleted once by a sweep; catalog source
    "render.yaml", // live Render half
    "src/app/api/health", // Cloud Run liveness probe
  ];
  for (const rel of KEPT) {
    it(`${rel} still exists (kept on purpose)`, () => {
      expect(existsSync(path.join(ROOT, rel)), `${rel} was deleted - it is ALIVE`).toBe(true);
    });
  }
});
