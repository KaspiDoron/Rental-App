import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

// THE BOOKING THAT NEVER REACHED THE SHOP.
//
// close-deal sends the closing message through the engine. When the anti-ban
// gate held it (shop closed overnight, pacing), the message was PARKED into
// wa_outbox - and the very next lines of the same route purged the ENTIRE
// outbox, tombstoned the shop, and reported `queued` as a failure. The
// traveller watched "Booking confirmed"; the shop never heard a word.
//
// Three separate drain-time mechanisms would each have killed a surviving row
// anyway: guardOutbound's tombstone veto, the drain's last-instant
// cancellation re-check, and the stale-draft recompose (whose recompose can
// never re-say "the deal is on" - the session is closed). Every pin below
// fails if its exemption is reverted.

const guard = readFileSync(join(process.cwd(), "src/lib/wa-guard.ts"), "utf8");
const route = readFileSync(
  join(process.cwd(), "src/app/api/negotiate/close-deal/route.ts"),
  "utf8"
);

describe("the closing message survives its own route", () => {
  it("the outbox purge excludes the just-parked closing row", () => {
    // An unfiltered `sender_key=eq.<email>` delete was the original bug.
    expect(route).toMatch(/id=neq\.\$\{closingRowId\}/);
    // The row id is captured from the engine's delivery result, not guessed.
    expect(route).toMatch(/closingRowId = result\?\.delivered\?\.outboxRowId \?\? null/);
  });

  it("queued is reported as queued, with its drain time", () => {
    expect(route).toMatch(/queued = result\?\.delivered\?\.delivered === "queued"/);
    expect(route).toMatch(/queuedUntil = result\?\.delivered\?\.queuedUntil \?\? null/);
    // The response carries both - BookingSheet.tsx:257 already branches on
    // d.queued; the server just never sent it.
    expect(route).toMatch(/\n    queued,\n    queuedUntil,/);
  });
});

describe("the deal-close row survives the drain", () => {
  it("guardOutbound's tombstone veto exempts kind deal-close", () => {
    const gate = guard.indexOf('?.kind === "deal-close"');
    const veto = guard.indexOf("cancelled-by-user - you removed the messages");
    expect(gate, "isDealClose derived from meta.kind").toBeGreaterThan(-1);
    expect(veto).toBeGreaterThan(-1);
    // The exemption must WRAP the veto: derived before, veto inside !isDealClose.
    expect(gate).toBeLessThan(veto);
    expect(guard).toMatch(/if \(!isDealClose\) \{/);
  });

  it("the last-instant cancellation re-check exempts deal-close", () => {
    expect(guard).toMatch(
      /rowKind !== "deal-close" &&\s*\n\s*\(await isCancelled\(row\.sender_key, row\.to_number\)\) === true/
    );
  });

  it("the stale-draft recompose never drops a deal-close row", () => {
    // staleDraftDropped's exemption list: rfq / custom / human-manual / deal-close.
    const fn = guard.slice(guard.indexOf("async function staleDraftDropped"));
    const head = fn.slice(0, fn.indexOf("composedAgainst;"));
    for (const k of ['"rfq"', '"custom"', '"human-manual"', '"deal-close"']) {
      expect(head, `${k} exempt from stale drop`).toContain(`rowKind === ${k}`);
    }
  });

  it("takeover still blocks even a deal-close (the human owns the chat)", () => {
    // The exemption is scoped to the cancellation tombstone ONLY - the
    // takeover veto stays outside the !isDealClose block.
    const exemptBlock = guard.slice(
      guard.indexOf("if (!isDealClose) {"),
      guard.indexOf("isThreadTakenOver")
    );
    expect(exemptBlock).not.toContain("takeover");
  });
});
