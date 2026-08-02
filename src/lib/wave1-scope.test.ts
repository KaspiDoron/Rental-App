import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const readCode = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

// ONE TRAVELLER'S POLL WAS DOING EVERYBODY'S WORK.
//
// /api/replies is the 8-SECOND poll - the most frequent request the app makes -
// and it called drainOutbox() and drainGraphWakeups() with NO sender scope and
// NO time budget. So a poll fired by one person executed other users' real
// WhatsApp sends and up to 24 other users' multi-agent LLM composes, inside
// their request. The two sibling routes doing the same job (/api/activity,
// /api/wa/status) had bounded theirs at 8s; this one was missed. And the client
// had no in-flight guard, so work that outran the interval stacked poll on poll.

describe("the 8-second poll is scoped to the person who fired it", () => {
  const route = readCode("src/app/api/replies/route.ts");

  it("drainOutbox runs only this traveller's rows", () => {
    expect(route).toMatch(/senderKey: session\.email/);
  });

  it("drainGraphWakeups runs only this traveller's threads", () => {
    expect(route).toMatch(/userEmail: session\.email/);
  });

  it("both drains are bounded, like the two sibling routes", () => {
    expect(route).toMatch(/const DRAIN_BUDGET_MS = 8_000;/);
    expect(route).toMatch(/Promise\.race\(\[p, new Promise\(\(r\) => setTimeout\(r, DRAIN_BUDGET_MS\)\)\]\)/);
    // Both calls go through it, not just the first.
    expect(route.match(/await bounded\(/g)?.length).toBe(2);
  });

  it("a drain failure is logged, not swallowed", () => {
    // A silent catch here stops every queued send with no trace anywhere.
    expect(route).toMatch(/\[drain:outbox\]/);
    expect(route).toMatch(/\[drain:wakeups\]/);
  });

  it("the wakeup scope filters on thread_key, not on the nullable column", () => {
    // user_email is stamped best-effort (there is a schema-graceful insert
    // without it), so rows written before that migration have it null and would
    // silently vanish from every scoped drain. thread_key is `<email>:<vendor>`
    // and has always been populated.
    const engine = readCode("src/lib/graph/engine.ts");
    expect(engine).toMatch(/thread_key=like\.\$\{encodeURIComponent\(`\$\{opts\.userEmail\}:\*`\)\}/);
    // ...and an unscoped call still drains everyone - that is the heartbeat's job.
    expect(engine).toMatch(/const ownerFilter = opts\?\.userEmail/);
  });

  it("the client cannot stack polls on top of each other", () => {
    const page = readCode("src/app/page.tsx");
    expect(page).toMatch(/let inFlight = false;/);
    expect(page).toMatch(/if \(inFlight\) return;/);
    // Released in `finally`, or one thrown error wedges the poll forever.
    expect(page).toMatch(/\} finally \{\s*inFlight = false;/);
  });
});

describe("the kill switch stops sends, not just searches", () => {
  it("guardOutbound checks it before anything else", () => {
    // It was checked in six API routes and in NONE of the paths that actually
    // put a message on WhatsApp, so flipping it stopped new searches while every
    // queued introduction and agent reply kept going out.
    // Scoped to guardOutbound's own body - `paused_until` is also read by a
    // helper far above it, and indexOf would find that one instead.
    const body = readCode("src/lib/wa-guard.ts").slice(
      readCode("src/lib/wa-guard.ts").indexOf("export async function guardOutbound")
    );
    const kill = body.indexOf("killSwitchOn");
    expect(kill).toBeGreaterThan(0);
    // Ahead of the account-pause gate, which is the first gate that existed.
    expect(kill).toBeLessThan(body.indexOf("rep.paused_until && Date.parse"));
  });

  it("automated sends PARK rather than fail, so nothing is lost", () => {
    const guard = readCode("src/lib/wa-guard.ts");
    expect(guard).toMatch(/queue\(jitteredHold\(now, 6, 4\), "paused by the operator \(kill switch\)"\)/);
  });

  it("...and a human's own typed message still goes through", () => {
    // The switch halts the AGENTS. A person deciding to message a shop
    // themselves is not the agents.
    const guard = read("src/lib/wa-guard.ts");
    const block = guard.slice(guard.indexOf("0.0 THE OWNER'S KILL SWITCH"));
    expect(block.slice(0, block.indexOf("0. GLOBAL ACCOUNT PAUSE"))).toMatch(/if \(opts\.auto\) \{/);
  });
});

describe("a plan grant that did not persist is not reported as success", () => {
  it("setPlan returns whether it landed", () => {
    const access = readCode("src/lib/access.ts");
    expect(access).toMatch(/export async function setPlan\(email: string, plan: PlanId\): Promise<boolean>/);
    expect(access).toMatch(/return await mirror\(rec\);/);
    // The "no such user" path is a failure too, not a silent no-op.
    expect(access).toMatch(/if \(!rec\) return false;/);
  });

  it("the verified-subscription path tells the traveller the truth", () => {
    const confirm = readCode("src/lib/billing/confirm-subscription.ts");
    expect(confirm).toMatch(/const granted = await setPlan\(email, tier\);/);
    expect(confirm).toMatch(/if \(!granted\) \{/);
    // The message must not imply they need to pay again - the money DID move.
    expect(read("src/lib/billing/confirm-subscription.ts")).toMatch(/no need to pay again/);
  });

  it("both sandbox grants refuse to claim a plan they did not apply", () => {
    for (const p of [
      "src/app/api/billing/confirm/route.ts",
      "src/app/api/billing/checkout/route.ts",
    ]) {
      expect(readCode(p), p).toMatch(/status: 503/);
    }
  });

  it("the webhook asks PayPal to retry instead of dropping the grant", () => {
    // Nobody is watching a webhook, so a failed write has to leave a trace AND
    // a recovery. A non-2xx is how PayPal is told to deliver it again.
    const hook = readCode("src/app/api/webhooks/paypal/route.ts");
    expect(hook).toMatch(/const granted = await setPlan\(email, tier\)\.catch\(\(\) => false\);/);
    expect(hook).toMatch(/plan_grant_failed_/);
    expect(hook).toMatch(/status: 503/);
  });
});

describe("the entry gate can actually succeed", () => {
  it("REPRODUCTION: the status read no longer waits behind the outbox drains", () => {
    // The endpoint's worst case was ~20s (a 4s socket probe plus two 8s drains,
    // all ahead of the response) while every client aborts at 8s - so under any
    // backlog the read could not succeed AT ALL.
    const probe = readCode("src/lib/wa-status.ts");
    expect(probe).toMatch(/\/api\/wa\/status\?drain=0&/);
    const route = readCode("src/app/api/wa/status/route.ts");
    expect(route).toMatch(/params\.get\("drain"\) === "0"/);
    // The drain still runs for callers that ARE acting as a worker tick.
    expect(route).toMatch(/if \(!pairing\) \{/);
  });

  it("REPRODUCTION: a timeout at signup no longer means 'no need to link'", () => {
    // A raw 8s fetch against that ~20s endpoint made `wa.ok` false, the
    // condition fell through, and a brand-new account went straight to plans
    // having never been offered WhatsApp linking - the one thing signup exists
    // to set up, removed silently by a slow backend.
    const login = readCode("src/app/login/page.tsx");
    expect(login).toMatch(/const wa = await probeWaStatus\(\{ pairing: true, attempts: 2 \}\);/);
    // Unknown must lead to SHOWING the step; only a definite "not configured"
    // skips it. `!wa.ok` gating the step is exactly the defect.
    expect(login).toMatch(/if \(wa\.available !== false && !wa\.connected\)/);
    expect(login).not.toMatch(/wa\.ok && wa\.data\?\.available/);
  });

  it("an unreachable probe is still its own outcome, never 'not linked'", () => {
    const probe = readCode("src/lib/wa-status.ts");
    expect(probe).toMatch(/return \{ reachable: false, connected: false \};/);
    for (const p of ["src/app/page.tsx", "src/app/profile/page.tsx"]) {
      expect(readCode(p), p).toMatch(/s\.reachable/);
    }
  });
});

describe("a rotated SESSION_SECRET is recoverable and visible", () => {
  it("SESSION_SECRET_PREVIOUS has a delivery path to the service", () => {
    // runtime-config has always tried this old value when decrypting. It was
    // absent from the deploy workflow, so the documented recovery for the one
    // secret that silently blanks every integration key could not be delivered.
    const wf = read(".github/workflows/deploy-gcp.yml");
    expect(wf).toMatch(/SESSION_SECRET_PREVIOUS: \$\{\{ secrets\.SESSION_SECRET_PREVIOUS \}\}/);
    expect(wf).toMatch(/for OPTIONAL in [^\n]*SESSION_SECRET_PREVIOUS; do/);
    expect(readCode("src/lib/runtime-config.ts")).toMatch(/SESSION_SECRET_PREVIOUS/);
  });

  it("the health route reports how many vault rows failed to decrypt", () => {
    expect(readCode("src/app/api/admin/health/route.ts")).toMatch(
      /vaultDecrypt: \(await import\("@\/lib\/runtime-config"\)\)\.vaultDecryptHealth\(\)/
    );
  });
});
