import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

// KO TAO, 31 JULY. Four threads, one pattern:
//
//   12:22 shop quotes 180  ->  12:39 our answer lands   (17 min)
//   12:23 shop quotes 250  ->  12:31 our answer lands   ( 8 min)
//   12:34 leverage composed ->  12:47 it lands          (13 min)
//   12:46 shop quotes      ->  12:49 our answer lands   ( 3 min)
//
// The last line is the tell. By 12:46 the cold introductions batch had
// finished draining, and the very next reply went out in three minutes. The
// composer was never slow. The reply was queued behind the batch's dispatcher.
//
// These tests pin the four places that queueing happened. They read source
// rather than run the routes because the pathologies are all in WHICH ROWS ARE
// ASKED FOR and WHO HOLDS THE LOCK - facts about the query and the claim key,
// not about a message body.

const guard = readCode("src/lib/wa-guard.ts");
const tick = readCode("src/app/api/wa/tick/route.ts");
const replyTick = readCode("src/app/api/wa/reply-tick/route.ts");
const ingest = readCode("src/lib/wa/ingest.ts");

describe("1. the chain refused every reply kick while a batch was draining", () => {
  it("a fresh kick that stands down RELEASES the window it just took", () => {
    // The "chain already live" branch won the CURRENT 30s slot two lines
    // earlier and then returned holding it. The live runner's next hop lost
    // that slot, slept 30s for the window to roll, and often lost again. More
    // inbound meant a deader drain - the exact inverse of what it should do.
    const branch = tick.slice(tick.indexOf('why: "chain already live"') - 900, tick.indexOf('why: "chain already live"'));
    expect(branch).toMatch(/sbDelete\(\s*"wa_send_claims"/);
    expect(branch).toMatch(/sender_key=eq\.__chain__/);
  });

  it("the in-process wait asks only about FUTURE work", () => {
    // With no lower bound, one overdue cold row - and a stalled batch leaves
    // dozens - pinned `due` negative forever. The loop then drained once, saw
    // the same row, called it "not progressing" and broke, so every hop did
    // exactly one drain. The wait a fast reply depends on never happened.
    const fn = tick.slice(tick.indexOf("const nextDueMs"), tick.indexOf("await drainOnce();"));
    expect(fn).toMatch(/not_before=gt\./);
    expect(fn).not.toMatch(/not_before=lte\./);
  });

  it("...so the dead 'due right now, not progressing' branch is gone", () => {
    expect(tick).not.toMatch(/not progressing/);
  });
});

describe("2. replies have a dispatcher no cold batch can hold", () => {
  it("it claims PER SENDER, not one global runner", () => {
    expect(replyTick).toMatch(/sender_key: "__reply__"/);
    expect(replyTick).toMatch(/reply:\$\{sender\}:/);
    // The chain's key is global by construction - that is the difference.
    expect(tick).toMatch(/sender_key: "__chain__"/);
  });

  it("it carries reply rows ONLY - the cold batch is not in its result set", () => {
    expect(replyTick).toMatch(/replyOnly: true/);
    expect(replyTick).toMatch(/senderKey: sender/);
  });

  it("it WAITS for a row that is due soon, which is the whole point", () => {
    // A reply is parked a human delay (~10-40s) out by design. A dispatcher
    // that only drains what is due right now can never deliver one on time.
    expect(replyTick).toMatch(/IN_CALL_BUDGET_MS/);
    expect(replyTick).toMatch(/setTimeout\(r, Math\.max\(0, due\)/);
  });

  it("it releases its claim BEFORE chaining - the bug the tick already had", () => {
    const chain = replyTick.slice(replyTick.indexOf("if (chaining)"));
    expect(chain.indexOf("sbDelete")).toBeGreaterThan(-1);
    expect(chain.indexOf("sbDelete")).toBeLessThan(chain.indexOf("reply-tick?token="));
  });

  it("ingest kicks it once per sender whose thread moved", () => {
    expect(ingest).toMatch(/touchedSenders\.add\(email\)/);
    expect(ingest).toMatch(/api\/wa\/reply-tick\?token=/);
    // The batch still needs its own driver - this is an addition, not a swap.
    expect(ingest).toMatch(/api\/wa\/tick\?token=/);
  });

  it("a definite LOSS stands down; an unreadable claims table does not", () => {
    // Inverted from a send claim on purpose: this lock only collapses a herd
    // of webhooks. Failing closed here would silence the lane on a blip.
    expect(replyTick).toMatch(/if \(claim === "lost"\)/);
    expect(replyTick).not.toMatch(/claim !== "won"/);
  });
});

describe("3. a reply row can no longer be dropped before it is ranked", () => {
  it("replies are selected in their OWN query, not filtered out of a global one", () => {
    // The priority sort has always promised replies go first. It ran on rows
    // that had already survived a global `not_before.asc LIMIT 48` across every
    // user - so past 48 overdue intros, a reply due seconds ago was never in
    // the list to rank.
    const fn = guard.slice(guard.indexOf("export async function drainOutbox"));
    expect(fn).toMatch(/const \[replyRows, anyRows\] = await Promise\.all\(/);
    expect(fn).toMatch(/meta->>kind=\$\{REPLY_KIND_FILTER\}/);
    expect(guard).toMatch(/REPLY_KIND_FILTER = "not\.in\.\(rfq,custom,human-manual\)"/);
  });

  it("one definition of 'a reply' is shared with the dispatcher", () => {
    expect(replyTick).toMatch(/REPLY_KIND_FILTER/);
    expect(replyTick).toMatch(/from "@\/lib\/wa-guard"/);
  });

  it("replyOnly skips the general select entirely", () => {
    const fn = guard.slice(guard.indexOf("export async function drainOutbox"));
    expect(fn).toMatch(/opts\?\.replyOnly\s*\n?\s*\?\s*Promise\.resolve\(\[\] as OutboxRow\[\]\)/);
  });
});

describe("4. the penalties are proportional to the lane", () => {
  const drain = guard.slice(guard.indexOf("export async function drainOutbox"));

  it("losing a pacing claim costs a reply seconds, a cold intro minutes", () => {
    expect(drain).toMatch(/RECIPIENT_LOCK_SEC \+ 2 \+ Math\.random\(\) \* 4/);
    expect(drain).toMatch(/isCold\(cand\)\s*\n?\s*\?\s*Date\.parse\(jitteredHold\(Date\.now\(\), 1, 2\)\)/);
  });

  it("a transient READ does not park a reply for five minutes", () => {
    // needsRepark is the fail-closed path: a reputation row or session flag
    // that could not be read. Under the load a 40-shop batch generates that is
    // routine, and it is the cleanest explanation for the 17- and 21-minute
    // outliers in the field.
    expect(drain).toMatch(/\(20 \+ Math\.random\(\) \* 20\) \* 1000/);
  });

  it("an over-budget reply comes back in ~10-16s, not 30-90s", () => {
    expect(drain).toMatch(/RECIPIENT_LOCK_SEC \+ 2 \+ Math\.random\(\) \* 6/);
    // ...while a cold intro is still smoothed by 2-4 min. Velocity to new
    // numbers is the ban vector; this is the one that must stay slow.
    expect(drain).toMatch(/jitteredHold\(Date\.now\(\), 2, 2\)/);
  });
});

describe("5. a cold batch's velocity no longer buys a reply a 30-minute fine", () => {
  it("the burst counter reads the row's kind, so the two lanes are separable", () => {
    expect(guard).toMatch(/kind:raw->>kind/);
  });

  it("an engaged reply is counted against a reply-only burst", () => {
    const burst = guard.slice(guard.indexOf("const burstWindowAgo"), guard.indexOf("6. ANTI-ROBOTIC"));
    expect(burst).toMatch(/burstRows\.filter\(\(r\) => r\.kind && r\.kind !== "rfq"\)/);
    expect(burst).toMatch(/reply burst cooldown/);
  });

  it("and cooled in seconds, where a cold burst still rests 30 minutes", () => {
    const burst = guard.slice(guard.indexOf("const burstWindowAgo"), guard.indexOf("6. ANTI-ROBOTIC"));
    expect(burst).toMatch(/\(45 \+ Math\.random\(\) \* 45\) \* 1000/);
    expect(burst).toMatch(/p\.burst_cooldown_minutes \* 60_000/);
  });

  it("a row with no recorded kind counts as COLD - the conservative read", () => {
    // `kind` is new on the outbound record. An older row must not be able to
    // inflate the reply budget just by being unlabelled.
    const burst = guard.slice(guard.indexOf("const burstWindowAgo"), guard.indexOf("6. ANTI-ROBOTIC"));
    expect(burst).toMatch(/r\.kind && r\.kind !== "rfq"/);
  });
});

describe("6. the turn itself stopped paying for a slow provider", () => {
  it("every app-path drain skips the presence simulation", () => {
    // 4-12s per row, and the activity poll's whole drain budget is 8s: one row
    // could consume it, so the poll sent a single message and timed out.
    expect(ingest).toMatch(/sendFromUser\(senderKey, to, text, true\)/);
    expect(readCode("src/app/api/wa/status/route.ts")).toMatch(
      /sendFromUser\(senderKey, to, text, true\)/
    );
    expect(readCode("src/app/api/activity/route.ts")).toMatch(/sendFromUser\(k, to, text, true\)/);
  });

  it("the offer extractor is budgeted like every other reply-path call", () => {
    // It sits at the FRONT of the turn - nothing starts until it returns - and
    // it was the only one still on the 38s default.
    const agents = readCode("src/lib/agents.ts");
    const textPath = agents.slice(agents.indexOf("let llm: string | null = null;"));
    expect(textPath.slice(0, 400)).toMatch(/budgetMs: 9_000/);
  });
});

describe("7. what is deployed is stated, not assumed", () => {
  it("the drain armer says plainly that it is dark in production", () => {
    // Read RAW, comments and all - a documentation claim is the thing under
    // test here, and the stripping reader every other test uses would delete
    // exactly what we are checking.
    const park = readFileSync(join(process.cwd(), "src/lib/wa/park.ts"), "utf8");
    expect(park).toMatch(/no Dockerfile CMD and no deploy manifest/);
    // The old comment claimed the Next path was covered by the tick kick. It
    // was - in code. In the field that kick was refused exactly when it
    // mattered, and nothing said so.
    expect(park).toMatch(/reply-tick/);
  });
});
