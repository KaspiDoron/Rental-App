// @wheeldeal/core - the negotiation brain's single import surface for every
// non-Next runtime (gateway, workers, future CLIs). Re-exports the proven
// modules from src/lib so the GCP services and the legacy Next app run the
// SAME code during the dual-run migration. When Vercel is decommissioned the
// files physically move here and only these re-export paths change.
//
// Node runtimes must alias "server-only" to shims/server-only.ts (see the
// service tsconfigs) - several underlying modules declare it for Next's
// client-boundary protection.

// The full inbound pipeline (extracted from the evolution webhook route).
export { processEvolutionWebhook } from "../../src/lib/wa/ingest";
export type { VisionFlowRequest } from "../../src/lib/wa/ingest";

// Agent loop + composition.
export { processVendorReply, photoClarifyExtraction } from "../../src/lib/agent-loop";
export type { ExtractedOffer } from "../../src/lib/agents";
export {
  extractOffer,
  composeBargain,
  runProfiler,
  variedFirstMessage,
  runSafety,
  currencyForRegion,
  money,
} from "../../src/lib/agents";

// Graph negotiation engine.
export {
  runGraphTurn,
  drainGraphWakeups,
  graphEngineEnabled,
  liveGraphIO,
} from "../../src/lib/graph/engine";
export {
  checkOutboundNumbers,
  correctDuration,
  buildSafeBargainAsk,
  stripRivalClaims,
  claimedRivalNumber,
} from "../../src/lib/graph/guardrails";

// Humanized copywriting engine (Module 4) - full modules also available at
// @wheeldeal/core/copy/{promptCompiler,matrix} for direct imports.
export {
  compileOpener,
  compileStyleDirectives,
  vehicleWording,
} from "../../src/lib/copy/promptCompiler";
export { openerSeed, drawStyle, seedRng } from "../../src/lib/copy/matrix";
export type { CopySeed } from "../../src/lib/copy/matrix";
export {
  ensureGloballyUnique,
  recordCopySignature,
  ensureGloballyFresh,
  trigramOverlap,
} from "../../src/lib/graph/uniqueness";

// Deterministic extraction + market intelligence.
export { extractRentalDailyPrice } from "../../src/lib/wa/price-extract";
export { coalesceUnreadInbound } from "../../src/lib/wa/coalesce";
export { shopAskedLocation } from "../../src/lib/wa/detectors";
export { floorPriceFor, vehicleKeyFor } from "../../src/lib/market";
export {
  cheapestRivalFor,
  pickCheapestRival,
  sessionSinceIso,
  currentSession,
} from "../../src/lib/search-session";

// WhatsApp transport + anti-ban guard (Redis port lands in Module 6).
export {
  webhookToken,
  emailForInstance,
  sendFromUser,
} from "../../src/lib/evolution";
export { guardOutbound, drainOutbox, afterSend } from "../../src/lib/wa-guard";

// Config / persistence primitives (PostgREST adapter - see @wheeldeal/db).
export {
  getConfig,
  sbSelect,
  sbInsert,
  sbUpdate,
} from "../../src/lib/runtime-config";

// Shared domain types.
export type { StructuredRFQ, Vendor, Offer, VehicleClass } from "../../src/lib/types";
