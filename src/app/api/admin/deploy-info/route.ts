import { NextResponse } from "next/server";
import { requireManagement } from "@/lib/session";
import { sbSelect } from "@/lib/runtime-config";

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
 *  exactly why it needs to be visible here. */
async function probe(table: string, select: string): Promise<Probe> {
  try {
    await sbSelect(table, `select=${select}&limit=1`);
    return { ok: true, detail: "present" };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message.slice(0, 200) : "unreadable" };
  }
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
  const [claims, outboxKey, searchRfq, consents, wakeups] = await Promise.all([
    probe("wa_send_claims", "sender_key"),
    probe("wa_outbox", "to_key"),
    probe("searches", "rfq,snapshot"),
    probe("app_users", "wa_risk_accepted_at,ai_responsibility_accepted_at"),
    probe("graph_wakeups", "id,not_before"),
  ]);
  const schema = {
    wa_send_claims: claims, // send mutex + idempotency; missing = locks fail open
    "wa_outbox.to_key": outboxKey, // one pending row per shop across spellings
    "searches.rfq/snapshot": searchRfq, // full session restore after an app kill
    "app_users consents": consents, // durable proof of the two extra consents
    graph_wakeups: wakeups, // every scheduled follow-up lives here
  };

  // --- is anything actually waking the system? -----------------------------
  let heartbeat: { lastAt: string | null; ageSec: number | null; ok: boolean; detail: string } = {
    lastAt: null,
    ageSec: null,
    ok: false,
    detail: "no ping recorded yet",
  };
  try {
    const rows = await sbSelect<{ created_at: string }>(
      "agent_events",
      "select=created_at&kind=eq.cron-ping&order=created_at.desc&limit=1"
    );
    const lastAt = rows[0]?.created_at ?? null;
    if (lastAt) {
      const ageMs = Date.now() - Date.parse(lastAt);
      heartbeat = {
        lastAt,
        ageSec: Math.round(ageMs / 1000),
        ok: ageMs < HEARTBEAT_STALE_MS,
        detail:
          ageMs < HEARTBEAT_STALE_MS
            ? "the drain is being called on schedule"
            : "NOTHING is draining the queue - queued messages and scheduled follow-ups are waiting for someone to open the app",
      };
    }
  } catch (e) {
    heartbeat.detail = e instanceof Error ? e.message.slice(0, 200) : "unreadable";
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
    ...Object.entries(schema)
      .filter(([, v]) => !v.ok)
      .map(([k]) => `schema: ${k} missing`),
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
