import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
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
