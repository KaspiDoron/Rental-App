import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  readingEmptyLine,
  readingFrom,
  readingHeadline,
  readingIsEmpty,
  readingUnavailable,
} from "./reading";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const readCode = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

// A PROMISE NOTHING HAD MADE.
//
// The proof panel printed, verbatim and unconditionally, whenever a reading came
// up blank: "We could not read anything usable from this one - your agent is
// asking the shop to type it instead."
//
// Nothing was asking. The sentence was hardcoded in the component with no send,
// no queue and no outbox behind it. On the live engine (SPTE) the clarify move
// is chosen per turn from the legal move set, and when the thread had ALREADY
// asked about the price the ledger deliberately removes that move - so the
// promise was not merely unverified, it was often the opposite of what happened.
//
// The reading now carries what the turn actually did, and the panel renders it.

describe("a reading knows whether anyone ever looked", () => {
  it("a blank extraction with no provenance is an empty read", () => {
    const r = readingFrom({}, {});
    expect(r.outcome).toBe("empty");
    expect(readingIsEmpty(r)).toBe(true);
    expect(readingUnavailable(r)).toBe(false);
    expect(readingHeadline(r)).toBe("Nothing readable in this one");
  });

  it("a failed vision pass is UNAVAILABLE, not empty", () => {
    const r = readingFrom({ imageRead: { seen: false, failure: "rate-limit" } }, {});
    expect(r.outcome).toBe("unavailable");
    expect(readingUnavailable(r)).toBe(true);
    expect(r.unavailableReason).toMatch(/quota/i);
    expect(readingHeadline(r)).toBe("Could not read this one yet");
    expect(readingEmptyLine(r)).toMatch(/did not get to read this one/i);
    // The critical half: it must NOT tell the traveller we read it and failed.
    expect(readingEmptyLine(r)).not.toMatch(/could not read anything usable/i);
    expect(readingEmptyLine(r)).toMatch(/nothing here was guessed/i);
  });

  it("each failure kind gets plain English, never a status code", () => {
    const line = (failure: string) =>
      readingEmptyLine(readingFrom({ imageRead: { seen: false, failure } }, {}));
    expect(line("auth")).toMatch(/rejected our key/i);
    expect(line("timeout")).toMatch(/did not answer in time/i);
    expect(line("blocked")).toMatch(/declined to describe/i);
    expect(line("unconfigured")).toMatch(/no image reader is configured/i);
    // An unknown kind still degrades to something true and readable.
    expect(line("something-new")).toMatch(/image reader was unavailable/i);
    for (const k of ["auth", "timeout", "blocked", "unconfigured", "something-new"]) {
      expect(line(k)).not.toMatch(/\b(401|403|429|500|null)\b/);
    }
  });

  it("a successful read is never marked unavailable", () => {
    const r = readingFrom(
      { imageRead: { seen: true }, imageSummary: "Honda Click 125, 300 THB per day" },
      {}
    );
    expect(r.outcome).toBe("read");
    expect(readingIsEmpty(r)).toBe(false);
  });

  it("a read that ran and found nothing stays 'empty'", () => {
    const r = readingFrom({ imageRead: { seen: true } }, {});
    expect(r.outcome).toBe("empty");
    expect(readingUnavailable(r)).toBe(false);
  });
});

describe("the panel states what the turn recorded, and nothing else", () => {
  it("with no follow-up recorded it claims nothing", () => {
    const r = readingFrom({}, {});
    expect(readingEmptyLine(r)).toBe("We could not read anything usable from this one.");
    expect(readingEmptyLine(r)).not.toMatch(/asking the shop/i);
  });

  it("a delivered clarify is reported in the past tense, because it happened", () => {
    const r = readingFrom({}, { followUp: { move: "clarify", delivered: "sent", at: "now" } });
    expect(readingEmptyLine(r)).toMatch(/your agent asked the shop to type the price out\.$/);
  });

  it("a queued clarify is reported as in flight, because it is", () => {
    const r = readingFrom({}, { followUp: { move: "clarify", delivered: "queued", at: "now" } });
    expect(readingEmptyLine(r)).toMatch(/your agent is asking the shop to type the price out\.$/);
  });

  it("deliberate silence is explained, not dressed up as an ask", () => {
    // This is the case the hardcoded sentence got exactly backwards: the ledger
    // removed the price question BECAUSE we had already asked it.
    const r = readingFrom({}, { followUp: { move: "silent", delivered: "silent", at: "now" } });
    expect(readingEmptyLine(r)).toMatch(/already asked for this/i);
    expect(readingEmptyLine(r)).toMatch(/rather than asking twice/i);
  });

  it("a move that never left claims nothing", () => {
    for (const delivered of ["held", "blocked", "failed"] as const) {
      const r = readingFrom({}, { followUp: { move: "clarify", delivered, at: "now" } });
      expect(readingEmptyLine(r)).toBe("We could not read anything usable from this one.");
    }
  });

  it("every move the engine can take after media has copy", () => {
    // A move with no entry falls back to the bare sentence, which is safe - but
    // silence about a real action is a worse panel, so keep the map complete.
    const moves = [
      "clarify",
      "deposit-probe",
      "fulfillment-probe",
      "option-probe",
      "confirm-vehicle",
      "answer",
      "bargain",
      "present",
      "pickup-location",
      "close",
      "redirect-close",
      "closing-message",
      "momentum",
    ];
    for (const move of moves) {
      const r = readingFrom({}, { followUp: { move, delivered: "sent", at: "now" } });
      expect(readingEmptyLine(r), `${move} has no copy`).toMatch(/ - your agent /);
    }
  });
});

describe("the wiring: the component renders the record, the loop writes it", () => {
  it("the hardcoded promise is gone from the component", () => {
    const c = read("src/components/AgenticSummary.tsx");
    expect(c).not.toMatch(/your agent is asking the shop to type it instead/);
    expect(readCode("src/components/AgenticSummary.tsx")).toMatch(
      /\{t\(readingEmptyLine\(reading\)\)\}/
    );
  });

  it("the live engine's own outcome is what gets stamped", () => {
    const loop = readCode("src/lib/agent-loop.ts");
    // The SPTE result was discarded; it carries both the chosen move and how
    // the send actually went, which is exactly what the panel needed.
    expect(loop).toMatch(/const spte = await runSpteLiveTurn\(turnInput, io\)/);
    expect(loop).toMatch(/recordMediaFollowUp\(spte\.move, spte\.delivered\)/);
    expect(loop).toMatch(/followUp: \{ move, delivered, at: new Date\(\)\.toISOString\(\) \}/);
  });
});
