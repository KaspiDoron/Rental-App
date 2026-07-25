import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

// Source-level regression pins for fixes whose behavior is integration-bound
// (SQL filters, external-fetch timeouts, instance-create bodies) and cannot be
// exercised as a pure unit. These assert the dangerous pattern stays GONE and
// the safe one stays present, so a future edit cannot silently reintroduce the
// confirmed defect.

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");
// Strip line + block comments so structural assertions match CODE, not the
// explanatory prose (which deliberately names the patterns being guarded).
const readCode = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
const count = (hay: string, needle: RegExp) => (hay.match(needle) ?? []).length;

describe("privacy: no unescaped SQL LIKE wildcard on user identity (cross-user leak)", () => {
  it("no `thread_key=like.` QUERY remains in src (graph_wakeups uses user_email=eq.)", () => {
    // Match the actual query form (template interpolation), not the prose in
    // the explanatory comments that document why the pattern was removed.
    for (const f of [
      "src/app/api/session/close/route.ts",
      "src/app/api/negotiate/close-deal/route.ts",
      "src/app/api/deals/route.ts",
      "src/app/api/activity/route.ts",
      "src/lib/will-answers.ts",
    ]) {
      expect(read(f)).not.toMatch(/thread_key=like\.\$\{/);
    }
  });

  it("wa_sessions reads use exact `email=eq.`, never `email=ilike.` (an `_` is a SQL wildcard)", () => {
    const evo = read("src/lib/evolution.ts");
    expect(evo).not.toMatch(/email=ilike\./);
  });
});

describe("privacy/data-minimization: syncFullHistory is never requested true", () => {
  it("evolution.ts declares syncFullHistory only as false, on every instance/create path", () => {
    const evo = read("src/lib/evolution.ts");
    expect(evo).not.toMatch(/syncFullHistory:\s*true/);
    // and it IS declared (so the create bodies actively opt out, not just omit)
    expect(count(evo, /syncFullHistory:\s*false/g)).toBeGreaterThanOrEqual(3);
  });
});

describe("anti-ban: pairing-layer client fingerprint (the ban happened AT pairing)", () => {
  it("presents a standard Chrome-on-macOS fingerprint, never the flagged default", () => {
    const evo = read("src/lib/evolution.ts");
    // The standard desktop WhatsApp-Web fingerprint is declared...
    expect(evo).toMatch(/\[\s*"Mac OS"\s*,\s*"Chrome"\s*,\s*"[\d.]+"\s*\]/);
    // ...and pinned to the WEB protocol (not the flagged mobile API).
    expect(evo).toMatch(/mobile:\s*false/);
    // ...and it is actually SPREAD into the primary create bodies (main create +
    // failover recreate). The last-resort flat-retry body DELIBERATELY omits it
    // so a strict validator that 400s on unknown fields can still pair via the
    // minimal legacy shape - hence >= 2, not every create path.
    const code = readCode("src/lib/evolution.ts");
    expect(count(code, /\.\.\.CONNECT_FINGERPRINT/g)).toBeGreaterThanOrEqual(2);
  });
});

describe("inbound recovery: webhook re-arm is non-destructive (never touches the session)", () => {
  it("reassertWebhook only calls /webhook/find + /webhook/set - never create/logout/delete", () => {
    const evo = readCode("src/lib/evolution.ts");
    const start = evo.indexOf("export async function reassertWebhook");
    expect(start).toBeGreaterThan(-1);
    // Bound the scan to the function body (up to the next top-level export).
    const body = evo.slice(start, evo.indexOf("\nexport ", start + 40));
    expect(body).toMatch(/\/webhook\/set\//);
    // The destructive session ops must NOT appear anywhere in the re-arm path.
    expect(body).not.toMatch(/instance\/create/);
    expect(body).not.toMatch(/instance\/logout/);
    expect(body).not.toMatch(/instance\/delete/);
  });

  it("connectInstance re-arms the webhook on the already-open early-return", () => {
    const evo = readCode("src/lib/evolution.ts");
    // The open-early-return block must reference reassertWebhook (a stale URL is
    // otherwise never refreshed for an already-linked user).
    expect(evo).toMatch(/existing === "open"[\s\S]{0,320}reassertWebhook/);
  });

  it("ensureConnected's failover recreate carries a webhook field (no webhook-less instance)", () => {
    const evo = readCode("src/lib/evolution.ts");
    expect(evo).toMatch(/recreateWebhook/);
    // and the derivation is present so the body can include it
    expect(evo).toMatch(/canonicalWebhookOrigin\(\)/);
  });
});

describe("anti-ban: send-side STOP-LOSS wired into the one send chokepoint", () => {
  it("wa-guard exports noteSendOutcome and evolution.ts feeds it on every outcome", () => {
    expect(read("src/lib/wa-guard.ts")).toMatch(/export async function noteSendOutcome/);
    const evo = read("src/lib/evolution.ts");
    // A clean send resets the streak; a hard failure feeds the breaker.
    expect(evo).toMatch(/noteSendOutcome\(email,\s*"ok"\)/);
    expect(evo).toMatch(/noteSendOutcome\(email,\s*hard\s*\?\s*"hard"\s*:\s*"soft"\)/);
  });
});

describe("defense-in-depth: RLS enabled on sensitive tables (deny-all for non-service-role)", () => {
  it("every sensitive table opts into row level security in schema.sql", () => {
    const sql = read("supabase/schema.sql");
    for (const tbl of [
      "offers",
      "searches",
      "bookings",
      "app_users",
      "whatsapp_messages",
      "wa_outbox",
      "wa_recipient_state",
    ]) {
      expect(sql).toMatch(new RegExp(`alter table public\\.${tbl}\\s+enable row level security`));
    }
  });
});

describe("resilience: external fetches are bounded by a hard timeout", () => {
  it("evoFetch aborts on a timeout (a cold Evolution host cannot hang the drain)", () => {
    const evo = read("src/lib/evolution.ts");
    const start = evo.indexOf("async function evoFetch");
    expect(start).toBeGreaterThan(-1);
    const body = evo.slice(start, evo.indexOf("async function", start + 10));
    expect(body).toMatch(/AbortController/);
    expect(body).toMatch(/ctrl\.abort\(\)/);
    expect(body).toMatch(/signal:\s*ctrl\.signal/);
  });

  it("every Supabase helper goes through timedFetch (only timedFetch's own call is a raw fetch)", () => {
    const code = readCode("src/lib/runtime-config.ts");
    expect(code).toMatch(/async function timedFetch/);
    // Exactly one raw lowercase `fetch(` survives in code: the one inside
    // timedFetch itself (all helpers call via `timedFetch(` - capital F).
    expect(count(code, /fetch\(/g)).toBe(1);
  });

  it("google.ts routes every Places call through its timedFetch wrapper", () => {
    const code = readCode("src/lib/google.ts");
    expect(code).toMatch(/async function timedFetch/);
    // Only the wrapper's own internal call is a raw lowercase fetch(.
    expect(count(code, /fetch\(/g)).toBe(1);
  });

  it("whatsapp.ts Cloud send is abort-bounded", () => {
    const code = readCode("src/lib/whatsapp.ts");
    expect(code).toMatch(/AbortController/);
    expect(code).toMatch(/signal:\s*ctrl\.signal/);
  });

  it("timedFetch keeps its deadline armed across the body read (no header-boundary clear)", () => {
    // The abort deadline must span headers+body: fetch() resolves at headers but
    // the read helpers then `await res.json()`. Clearing the timer at the header
    // boundary left the body read unbounded (a mid-body DB stall hung the handler
    // and, on the drain path, lost an already-claimed row).
    const code = readCode("src/lib/runtime-config.ts");
    expect(code).not.toMatch(/clearTimeout/);
    expect(code).toMatch(/\.unref\?\.\(\)/);
  });
});
