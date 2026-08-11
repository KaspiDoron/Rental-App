import { describe, it, expect, vi } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

vi.mock("server-only", () => ({}));

// WORK THAT DIES AT THE RESPONSE FLUSH.
//
// This deployment runs on Cloud Run with the DEFAULT CPU allocation, which
// means the container's CPU drops to ~0 the instant the response is flushed. An
// outgoing fetch that has not yet finished its DNS/TCP/TLS handshake at that
// moment simply stops existing - no error, no log, nothing.
//
// The codebase knows this. `kick.ts` was written for it, derives
// KICK_SETTLE_MS = 1200 from it, and races that window against the callee
// answering so the common case still costs milliseconds. And then three sites
// hand-rolled the same idea with `fetch(...).catch(() => {})` followed by
// `setTimeout(350)` - under a THIRD of the settle floor, on the theory that a
// round trip is fast. On a cold connection it routinely is not, and the failure
// is silent by construction:
//
//   wa/tick        the drain chain ends at whatever hop lost the race
//   wa/reply-tick  WORSE: the claim is released BEFORE the hop is fired (so a
//                  returning runner cannot starve its own successor), which
//                  means a hop that never leaves takes the window down with it
//                  and nobody drains that sender at all
//   outreach/mass  the batch a traveller JUST clicked falls back to whatever
//                  pokes the server next - the slow-first-send report
//
// One implementation, used everywhere.

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(join(process.cwd(), dir), { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".next" || e.name === "dist") continue;
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

const SELF_KICK_ROUTES = [
  "src/app/api/wa/tick/route.ts",
  "src/app/api/wa/reply-tick/route.ts",
  "src/app/api/outreach/mass/route.ts",
];

describe("every self-kick goes through the one settle implementation", () => {
  it.each(SELF_KICK_ROUTES)("%s awaits kickDispatcher", (p) => {
    const code = readCode(p);
    expect(code).toMatch(/await kickDispatcher\(/);
  });

  it("REGRESSION: no hand-rolled 350ms settle survives", () => {
    for (const p of SELF_KICK_ROUTES) {
      const code = readCode(p);
      expect(code, `${p} still sleeps a hand-picked settle`).not.toMatch(
        /setTimeout\(r, 350\)/
      );
    }
  });

  it("REGRESSION: no bare unawaited self-kick survives anywhere", () => {
    // The shape: `fetch(<something with /api/wa/ in it>).catch(() => {})` with
    // nothing awaited. That is the exact line that vanished at flush time.
    const offenders: string[] = [];
    for (const f of walk("src").filter((f) => !/\.test\./.test(f))) {
      const code = readCode(f);
      const RE = /(^|[^.\w])fetch\(\s*`[^`]*\/api\/wa\/[^`]*`\s*\)\s*\.catch/g;
      for (let m = RE.exec(code); m; m = RE.exec(code)) {
        const line = code.slice(0, m.index).split("\n").length;
        offenders.push(`${f}:${line}`);
      }
    }
    expect(
      offenders,
      `unawaited self-kicks die at the Cloud Run response boundary:\n${offenders.join("\n")}`
    ).toEqual([]);
  });

  it("the settle floor is still the one kick.ts derived", () => {
    const kick = readCode("src/lib/wa/kick.ts");
    const ms = Number(/KICK_SETTLE_MS = (\d+)/.exec(kick)?.[1]);
    expect(ms).toBe(1200);
    // And it races the callee answering, so a successor that stands down
    // immediately does not cost the caller a second.
    expect(kick).toMatch(/Promise\.race\(\[call,/);
  });
});

describe("the reply lane's release ordering is intact", () => {
  const route = readCode("src/app/api/wa/reply-tick/route.ts");

  it("the claim is released BEFORE the hop, and the hop is now guaranteed to leave", () => {
    const release = route.indexOf("wa_send_claims");
    const kick = route.indexOf("await kickDispatcher(");
    expect(release).toBeGreaterThan(-1);
    expect(kick).toBeGreaterThan(-1);
    // Release first - a runner holding its window makes its own successor lose.
    expect(release).toBeLessThan(kick);
    // Which is exactly why the hop must be settled: without it the release is
    // paid for with a handoff that may not have happened.
  });
});

describe("the scheduler worker sends on the right lane, at the right speed", () => {
  const worker = readCode("services/workers/src/scheduler.worker.ts");

  it("REGRESSION: it no longer drops the lane the drain handed it", () => {
    // sendFromUser defaults to the INTRO lane (the tighter cold cap) and to the
    // slow presence simulation, so every agent reply drained here was metered
    // against the cold-introduction budget and paid 4-12s of typing theatre.
    // Same defect RC-2 fixed at the route sites; this worker sat outside that
    // sweep, which is how a defect survives its own fix.
    expect(worker).toMatch(/drainOutbox\(\(senderKey, to, text, lane\) =>/);
    expect(worker).toMatch(/sendFromUser\(senderKey, to, text, true, \{ lane \}\)/);
  });

  it("wakeups are replies by definition and say so", () => {
    expect(worker).toMatch(/sendFromUser\(senderKey, to, text, true, \{ lane: "reply" \}\)/);
  });

  it("no drain callback anywhere sends without a lane", () => {
    // The RC-2 sweep, re-run over services/ and packages/ as well - the two
    // trees it did not cover the first time.
    const offenders: string[] = [];
    for (const f of [
      ...walk("src"),
      ...walk("services"),
      ...walk("packages"),
    ].filter((f) => !/\.test\./.test(f))) {
      const code = readCode(f);
      const RE = /drain(?:Outbox|GraphWakeups)\(/g;
      for (let m = RE.exec(code); m; m = RE.exec(code)) {
        // A fixed window is deliberate: a non-greedy paren match stops at the
        // callback's OWN parameter list, which is how the first version of this
        // sweep passed while every site was still broken.
        const window = code.slice(m.index, m.index + 260);
        if (!/sendFromUser\(/.test(window)) continue;
        if (/lane/.test(window)) continue;
        offenders.push(`${f}:${code.slice(0, m.index).split("\n").length}`);
      }
    }
    expect(
      offenders,
      `these drains meter replies against the cold-intro cap:\n${offenders.join("\n")}`
    ).toEqual([]);
  });
});
