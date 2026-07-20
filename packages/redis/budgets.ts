// @wheeldeal/redis/budgets - plan-tier outreach budget hot state (Module 6).
//
// The CANONICAL implementation lives in src/lib/budget-cache.ts (the "brain in
// src/lib, packages re-export" pattern) because the same code runs in both
// runtimes during the dual-run: REDIS_URL-gated no-ops on Vercel (the mass
// route keeps its Postgres budget), the full INCR/ZSET hot path on the VM.
// Services import from HERE so the physical relocation later is a path change.

export {
  // key builders (pure - shared schema, unit-tested)
  introsKey,
  introsLiveKey,
  campaignSlotKey,
  campaignHeldKey,
  campaignKey,
  // intro-window mirror
  introUsage,
  seedIntroWindow,
  recordIntro,
  // concurrent-campaign gate
  tryAcquireCampaignSlot,
  releaseCampaignSlot,
  // campaign progress hash
  initCampaign,
  bumpCampaign,
  completeVendorJob,
  setCampaignState,
  readCampaign,
} from "../../src/lib/budget-cache";

export type {
  CampaignSlot,
  CampaignState,
  CampaignInit,
} from "../../src/lib/budget-cache";
