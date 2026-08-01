import { NextResponse } from "next/server";
import { requireManagement } from "@/lib/session";
import { sbSelect } from "@/lib/runtime-config";
import { tableReady, schemaDetail } from "@/lib/schema-probe";

export const dynamic = "force-dynamic";

// "IS THE FIX I SHIPPED ACTUALLY RUNNING?"
//
// Until this route existed there was no way to answer that from a phone. A
// field test would fail, and the two possible explanations - the code is wrong,
// or the code was never live - were indistinguishable. A whole round of fixes
// was verified green in CI, deployed, and then behaved exactly as before,
// because the behaviour depended on things nothing in the app could see: which
// revision Cloud Run was serving, whether a migration had been applied, whether
// any scheduler was still calling the drain, whether an LLM provider was
// answering at all.
//
// So this is a single screen of ground truth, owner-gated, cheap to compute:
// what is serving, what the database actually has, when the heartbeat last
// beat, and whether the model providers are configured. Anything red here
// explains a field failure before a single line of code is suspected.

/** How stale the drain heartbeat may be before it is a problem. The schedule
 *  is every minute; three misses is a lapse, not a blip. */
const HEARTBEAT_STALE_MS = 3 * 60_000;

type Probe = { ok: boolean; detail: string };

/** Does a table/column the code depends on actually exist in THIS database?
 *  A missing one fails softly at runtime (the helpers degrade), which is
 *  exactly why it needs to be visible here.
 *
 *  THIS PROBE COULD NOT FAIL. It wrapped `sbSelect` in a try/catch, and
 *  `sbSelect` has no throw path - unconfigured, not-ok and thrown all collapse
 *  to []. So the catch was dead code and every probe returned `ok: true`
 *  whatever the database contained: a green card over an empty schema, which is
 *  the one failure this card exists to make impossible. `tableReady` asks the
 *  question through `sbSelectStrict`, which can actually answer it. */
async function probe(table: string, select: string): Promise<Probe> {
  const state = await tableReady(table, select);
  return { ok: state === "ready", detail: schemaDetail(state) };
}

export async function GET() {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  // --- what is serving -----------------------------------------------------
  const build = {
    sha: process.env.WD_BUILD_SHA ?? null,
    at: process.env.WD_BUILD_AT ?? null,
    revision: process.env.K_REVISION ?? null,
    node: process.version,
  };

  // --- what the database actually has --------------------------------------
  // Each of these is a fix whose behaviour silently degrades to the pre-fix
  // state if the column is missing, which is the least debuggable failure this
  // app has.
  const [claims, outboxKey, searchRfq, consents, termsVersion, ledger, wakeups] =
    await Promise.all([
      probe("wa_send_claims", "sender_key"),
      probe("wa_outbox", "to_key"),
      probe("searches", "rfq,snapshot"),
      probe("app_users", "wa_risk_accepted_at,ai_responsibility_accepted_at"),
      // Without this column a TERMS_VERSION bump asks nobody to re-accept, and
      // no user record can say WHICH version they agreed to - the exact silent
      // degradation this whole probe list exists to catch.
      probe("app_users", "terms_version"),
      // The per-event ledger: WhatsApp linking releases and booking-time deal
      // terms. Missing = those acceptances are written nowhere at all.
      probe("consent_events", "email,kind,version"),
      probe("graph_wakeups", "id,not_before"),
    ]);
  const schema = {
    wa_send_claims: claims, // send mutex + idempotency; missing = locks fail open
    "wa_outbox.to_key": outboxKey, // one pending row per shop across spellings
    "searches.rfq/snapshot": searchRfq, // full session restore after an app kill
    "app_users consents": consents, // durable proof of the two extra consents
    "app_users.terms_version": termsVersion, // re-acceptance on a version bump
    consent_events: ledger, // per-event proof: WhatsApp linking + deal terms
    graph_wakeups: wakeups, // every scheduled follow-up lives here
  };

  // --- is anything actually waking the system? -----------------------------
  // TWO RED HEARTBEATS MEAN DIFFERENT THINGS, AND THE FIX IS DIFFERENT.
  //
  //   "never"  - nothing has EVER called the drain. The schedule was never
  //              created (the deploy's scheduler step needs GCP roles the
  //              deploying account may not have) - an infrastructure gap.
  //   "stale"  - it ran and then stopped. A lapse: a deleted job, a rotated
  //              token, a paused schedule.
  //
  // The card said "never - no ping recorded yet" for both, which reads like a
  // bug in the app rather than a missing cron job. Name the state and give the
  // next action inline.
  let heartbeat: {
    lastAt: string | null;
    ageSec: number | null;
    ok: boolean;
    state: "never" | "stale" | "live" | "unreadable";
    detail: string;
    nextStep?: string;
  } = {
    lastAt: null,
    ageSec: null,
    ok: false,
    state: "never",
    detail: "nothing has ever called the drain on this deployment",
    nextStep:
      "The schedule was never created. Re-run the deploy (the workflow now says exactly which GCP role is missing if it cannot create it), or tap 'Run the drain now' below to prove the machinery works meanwhile.",
  };
  try {
    const rows = await sbSelect<{ created_at: string }>(
      "agent_events",
      "select=created_at&kind=eq.cron-ping&order=created_at.desc&limit=1"
    );
    const lastAt = rows[0]?.created_at ?? null;
    if (lastAt) {
      const ageMs = Date.now() - Date.parse(lastAt);
      const live = ageMs < HEARTBEAT_STALE_MS;
      heartbeat = {
        lastAt,
        ageSec: Math.round(ageMs / 1000),
        ok: live,
        state: live ? "live" : "stale",
        detail: live
          ? "the drain is being called on schedule"
          : "the drain STOPPED being called - queued messages and scheduled follow-ups are waiting for someone to open the app",
        nextStep: live
          ? undefined
          : "It ran before and stopped: check the Cloud Scheduler job still exists and is enabled, and that SESSION_SECRET has not been rotated (the ping token is derived from it).",
      };
    }
  } catch (e) {
    heartbeat = {
      ...heartbeat,
      state: "unreadable",
      detail: e instanceof Error ? e.message.slice(0, 200) : "unreadable",
    };
  }

  // --- can the agents think? -----------------------------------------------
  // With no reachable provider the engine still runs, but on deterministic
  // fallbacks: replies get blunter, local-language output silently reverts to
  // English, and semantic classification stops. That is a state the owner must
  // be able to SEE rather than infer from tone.
  let ai: { configured: boolean; providers: string[]; detail: string } = {
    configured: false,
    providers: [],
    detail: "no provider key configured - agents are running on deterministic fallbacks",
  };
  try {
    const { configuredProviders } = await import("@/lib/ai");
    const providers = await configuredProviders();
    ai = {
      configured: providers.length > 0,
      providers,
      detail: providers.length
        ? `${providers.length} provider${providers.length > 1 ? "s" : ""} configured`
        : ai.detail,
    };
  } catch (e) {
    ai.detail = e instanceof Error ? e.message.slice(0, 200) : "unreadable";
  }

  const problems = [
    // Carry the probe's own detail: "missing" (run schema.sql) and "unreadable"
    // (Supabase did not answer) need different actions from the owner, and this
    // list is the only line they may read.
    ...Object.entries(schema)
      .filter(([, v]) => !v.ok)
      .map(([k, v]) => `schema: ${k} - ${v.detail}`),
    ...(heartbeat.ok ? [] : ["heartbeat: nothing is draining the queue"]),
    ...(ai.configured ? [] : ["ai: no provider configured"]),
  ];

  return NextResponse.json({
    ok: problems.length === 0,
    problems,
    build,
    schema,
    heartbeat,
    ai,
    at: new Date().toISOString(),
  });
}
