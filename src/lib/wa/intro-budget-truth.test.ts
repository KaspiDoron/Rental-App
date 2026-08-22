import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { classifyQueueReason, queueReasonLabel, queueReasonWhy } from "../queue-reason";
import {
  outboxExpired,
  OUTBOX_MAX_AGE_MS,
  OUTBOX_ABSOLUTE_MAX_AGE_MS,
} from "./outbox-policy";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

// "I PICKED 12 SHOPS, 5 GOT MESSAGED, 7 VANISHED."
//
// The introductions budget admits the MINIMUM of four ceilings, and every one
// of them was announced with the same sentence: "introductions full - refreshes
// soon". For the plan's rolling window that is true. For Meter A - the count of
// introductions nobody has answered - it is false and actively misleading: a
// free traveller sits at zero the moment five shops have gone quiet, and
// nothing refreshes until a shop WRITES BACK or the oldest silent one turns
// seven days old.
//
// The hold then borrowed the plan window's clock (~an hour), so the row
// re-parked hourly, and the 6h outbox freshness ceiling binned it - with an
// admin-only event. The traveller was told the shops were coming, and they
// never went.

describe("the introductions budget names WHICH ceiling is binding", () => {
  const guard = read("src/lib/wa-guard.ts");

  it("the four ceilings are distinguishable, not collapsed into one number", () => {
    expect(guard).toMatch(/export type IntroBudgetBind =[\s\S]{0,120}"unanswered"/);
    // Computed from the same four terms the minimum is taken over.
    expect(guard).toMatch(/const windowHeadroom = Math\.max\(0, cap - count\);/);
    expect(guard).toMatch(/windowHeadroom <= 0[\s\S]{0,60}"window"/);
    expect(guard).toMatch(/openHeadroom <= 0[\s\S]{0,60}"unanswered"/);
    expect(guard).toMatch(/monthHeadroom <= 0[\s\S]{0,80}"monthly"/);
  });

  it("Meter A gets its own clock, not the plan window's", () => {
    // nextIntroSlotIso answers "when does a SENT introduction age out of the
    // plan window" - a different question entirely. The honest instant is when
    // the oldest still-unanswered introduction leaves the 7-day window.
    expect(guard).toMatch(/oldestOpenAt: string \| null;/);
    expect(guard).toMatch(
      /bind === "unanswered" && meters\?\.oldestOpenAt[\s\S]{0,200}UNANSWERED_WINDOW_DAYS \* 24 \* 3600_000/
    );
    // ...and the read has to be ordered for `rows[0]` to BE the oldest.
    expect(guard).toMatch(/order=first_intro_at\.asc/);
  });

  it("the slow ceilings do not borrow the plan window's hold length either", () => {
    expect(guard).toMatch(
      /const holdHours = budget\.bind === "window" \|\| !budget\.bind \? windowHours : 12;/
    );
  });

  it("one function words the hold, so the two park sites cannot disagree", () => {
    expect(guard).toMatch(/export function introHoldReason\(bind: IntroBudgetBind \| undefined\): string/);
    // The guard's drain-path park...
    expect(guard).toMatch(/queue\(until, introHoldReason\(budget\.bind\), budget\.bind !== "window"\)/);
    // ...and the mass route's click-time park.
    const mass = read("src/app/api/outreach/mass/route.ts");
    expect(mass).toMatch(/introHoldReason\(\(budget as \{ bind\?: IntroBudgetBind \}\)\.bind\)/);
    // The traveller is told at click time too, not only on the parked row.
    expect(mass).toMatch(/\{ bind: \(budget as \{ bind\?: IntroBudgetBind \}\)\.bind \}/);
  });

  it("the unanswered hold does not claim anything refreshes soon", () => {
    const guardSrc = read("src/lib/wa-guard.ts");
    const m = guardSrc.match(/case "unanswered":[\s\S]{0,400}?return "([^"]+)"/);
    expect(m).toBeTruthy();
    const copy = m![1];
    expect(copy).not.toMatch(/refresh/i);
    expect(copy).toMatch(/waiting on replies/);
  });
});

describe("the traveller is told what is actually true", () => {
  it("waiting on a shop is not classified as capacity", () => {
    const kind = classifyQueueReason(
      "waiting on replies - a new shop opens as soon as one of the shops already messaged answers"
    );
    expect(kind).toBe("awaiting-replies");
    expect(kind).not.toBe("capacity");
  });

  it("the plan window keeps its own, still-true copy", () => {
    expect(classifyQueueReason("introductions full - refreshes soon")).toBe("capacity");
    expect(queueReasonLabel("introductions full - refreshes soon")).toMatch(/shortly, automatically/);
  });

  it("the label promises a reply, not a clock", () => {
    const label = queueReasonLabel(
      "waiting on replies - a new shop opens as soon as one of the shops already messaged answers"
    );
    expect(label).toMatch(/as soon as one answers/);
    expect(label).not.toMatch(/shortly, automatically/);
    const why = queueReasonWhy(
      "waiting on replies - a new shop opens as soon as one of the shops already messaged answers"
    );
    expect(why).toBeTruthy();
    expect(why!).toMatch(/have not written back/);
  });

  it("the owner's two slower ceilings read as limits, never as silence", () => {
    expect(
      classifyQueueReason("monthly ceiling on shops that never replied - protecting your number")
    ).toBe("limit");
    expect(
      classifyQueueReason("daily new-shop ceiling reached - refreshes as today's introductions age out")
    ).toBe("limit");
  });
});

describe("a row serving a wait we gave it is not binned for serving it", () => {
  const now = Date.parse("2026-08-22T12:00:00.000Z");
  const hours = (n: number) => n * 3600_000;

  it("clearing the stamp restarts the freshness clock", () => {
    // Stamped and stale: binned, as before.
    expect(
      outboxExpired(
        {
          createdAt: new Date(now - hours(9)).toISOString(),
          firstDueAt: now - hours(8),
          notBefore: new Date(now - hours(8)).toISOString(),
        },
        now
      )
    ).toBe(true);
    // Same row, re-scheduled by the guard (stamp cleared) and parked ahead:
    // it is serving a NEW schedule, so it survives.
    expect(
      outboxExpired(
        {
          createdAt: new Date(now - hours(9)).toISOString(),
          firstDueAt: null,
          notBefore: new Date(now + hours(12)).toISOString(),
        },
        now
      )
    ).toBe(false);
  });

  it("...but the absolute wall still bounds it, so nothing lives forever", () => {
    expect(OUTBOX_ABSOLUTE_MAX_AGE_MS).toBeGreaterThan(OUTBOX_MAX_AGE_MS);
    // A row re-scheduled over and over never accrues bounce age at all - this
    // is the hole the wall closes. Composed 25h ago, parked into the future,
    // no stamp: the bounce ceiling cannot see it; the wall can.
    expect(
      outboxExpired(
        {
          createdAt: new Date(now - hours(25)).toISOString(),
          firstDueAt: null,
          notBefore: new Date(now + hours(4)).toISOString(),
        },
        now
      )
    ).toBe(true);
    // And a row a day old is still fine at 23h.
    expect(
      outboxExpired(
        {
          createdAt: new Date(now - hours(23)).toISOString(),
          firstDueAt: null,
          notBefore: new Date(now + hours(1)).toISOString(),
        },
        now
      )
    ).toBe(false);
  });

  it("a database with no created_at column is unchanged by the wall", () => {
    // The wall is opt-in on the column existing; the legacy reading survives.
    expect(
      outboxExpired({ firstDueAt: null, notBefore: new Date(now + hours(1)).toISOString() }, now)
    ).toBe(false);
    expect(
      outboxExpired({ notBefore: new Date(now - hours(7)).toISOString() }, now)
    ).toBe(true);
  });
});
