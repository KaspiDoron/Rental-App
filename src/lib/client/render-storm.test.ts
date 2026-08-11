import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
// Relative, not "@/" - vitest resolves no path alias in this repo.
import { reconcileMessages } from "../../components/useTranscriptScroll";
import type { ThreadMsg } from "../../components/MessageBubble";

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

// ONE NUMBER BROKE EVERY MEMO IN THE FILE.
//
// `epochOnServerClock()` returned `searchEpoch + clockSkewRef.current`, and the
// skew was `serverNow - Date.now()` where serverNow is stamped at the END of
// the /api/activity handler - an endpoint whose own comment says it awaits up
// to ~16s of drain work. So the "skew" carried the full response transit and
// JSON parse, and moved by tens to thousands of ms on EVERY poll.
//
// That number was a prop on every memoised child. VendorCard is memo()'d with a
// shallow compare; vendors keep identity through reconcileList, agentPending
// through reconcileRecord, handlers through useCallbackRef - every other
// memo-stability defence in page.tsx holds, and then this one jittering number
// undid all of them. memo-stability.test.ts checks agentPending and inline
// arrows; it never looked at searchEpoch.
//
// It was also an effect DEPENDENCY three levels down: ThreadPeek,
// ThreadDashboard and TranscriptSheet key their polls on it, so every tick tore
// down and rebuilt those effects - aborting the in-flight request every ~6s. On
// a connection slower than the poll interval the conversation peek never
// completed at all, so engaged cards showed no last message, permanently.

describe("the epoch the render tree sees is stable", () => {
  const page = readCode("src/app/page.tsx");

  it("REGRESSION: epochOnServerClock reads quantized state, not the raw ref", () => {
    expect(page).toMatch(/const epochOnServerClock = \(\) =>\s*\(searchEpoch \? searchEpoch \+ clockSkew : 0\)/);
    expect(page).not.toMatch(/searchEpoch \+ clockSkewRef\.current : 0/);
  });

  it("the quantization FLOORS, so the epoch can only move earlier", () => {
    // The epoch feeds `since=` filters. An epoch that moved LATER would drop
    // replies - the exact failure the skew correction was added to prevent.
    expect(page).toMatch(/Math\.floor\(raw \/ SKEW_STEP_MS\) \* SKEW_STEP_MS/);
    expect(page).toMatch(/const SKEW_STEP_MS = 30_000;/);
  });

  it("the raw estimate uses the round-trip midpoint, not the arrival time", () => {
    // serverNow was compared against Date.now() AFTER the response was parsed,
    // so the transit time was counted as clock drift.
    expect(page).toMatch(/const sentAt = Date\.now\(\);/);
    expect(page).toMatch(/serverNow - \(sentAt \+ Date\.now\(\)\) \/ 2/);
  });

  it("the raw value is still what the query string uses - accuracy where it is free", () => {
    expect(page).toMatch(/since=\$\{\(searchEpoch \|\| Date\.now\(\) - 86400000\) \+ clockSkewRef\.current\}/);
  });
});

describe("a stale suggestion cannot set the search origin", () => {
  const auto = readCode("src/components/PlaceAutocomplete.tsx");

  it("REGRESSION: a request token gates every UI write", () => {
    expect(auto).toMatch(/const turnRef = useRef\(0\);/);
    expect(auto).toMatch(/const myTurn = \+\+turnRef\.current;/);
    expect(auto).toMatch(/if \(myTurn !== turnRef\.current\)/);
  });

  it("...and the superseded request is aborted, not merely ignored", () => {
    // Ignoring alone still pays for a billed Place Details call and still holds
    // a socket. Both matter on a mobile connection.
    expect(auto).toMatch(/abortRef\.current\?\.abort\(\);/);
    expect(auto).toMatch(/\{ signal: ctrl\.signal \}/);
    expect(auto).toMatch(/ctrl\.abort\(\);/);
  });

  it("an abort is not reported as a connection failure", () => {
    expect(auto).toMatch(/AbortError/);
  });

  it("a superseded response still fills the cache - it was a real answer", () => {
    // Keyed by ITS OWN query, so it is correct; only the UI write is unsafe.
    expect(auto).toMatch(/SUGGESTION_CACHE\.set\(\s*q\.toLowerCase\(\)/);
  });

  it("...and the sibling components that DID guard this are why we know the shape", () => {
    expect(readCode("src/components/ThreadDashboard.tsx")).toMatch(/inFlight\?\.abort\(\);/);
  });
});

describe("reading back through a transcript is possible again", () => {
  const msg = (id: string, text = "hi"): ThreadMsg =>
    ({ id, dir: "in", text, at: "2026-08-11T00:00:00Z" }) as ThreadMsg;

  it("REPRODUCTION: an unchanged poll keeps the SAME array", () => {
    // A new array on every tick is what made the scroll effect fire every 5s.
    const prev = [msg("a"), msg("b")];
    const next = [msg("a"), msg("b")];
    expect(reconcileMessages(prev, next)).toBe(prev);
  });

  it("a new message replaces it, because that IS a change", () => {
    const prev = [msg("a")];
    const next = [msg("a"), msg("b")];
    expect(reconcileMessages(prev, next)).toBe(next);
  });

  it("an edited last message replaces it too", () => {
    const prev = [msg("a", "hi")];
    expect(reconcileMessages(prev, [msg("a", "hi there")])).not.toBe(prev);
  });

  it("first load always takes the new list", () => {
    const next = [msg("a")];
    expect(reconcileMessages(null, next)).toBe(next);
  });

  it("both transcripts reconcile and follow-scroll, rather than snapping", () => {
    for (const p of [
      "src/components/ThreadDashboard.tsx",
      "src/components/activity/TranscriptSheet.tsx",
    ]) {
      const src = readCode(p);
      expect(src, p).toMatch(/reconcileMessages\(prev,/);
      expect(src, p).toMatch(/useFollowNewMessages\(scrollerRef, endRef, messages\)/);
      // The unconditional snap is gone.
      expect(src, p).not.toMatch(/endRef\.current\?\.scrollIntoView\(\{ block: "end" \}\);\s*\}, \[messages\]\)/);
    }
  });

  it("the follow only fires while the reader is already at the bottom", () => {
    const hook = readCode("src/components/useTranscriptScroll.ts");
    expect(hook).toMatch(/if \(!wasAtBottom\.current\) return;/);
    expect(hook).toMatch(/el\.scrollHeight - el\.scrollTop - el\.clientHeight <= FOLLOW_SLACK_PX/);
    // Passive, because this runs on every scroll frame of a chat panel.
    expect(hook).toMatch(/\{ passive: true \}/);
  });
});

describe("TranscriptSheet got the guard its sibling documented", () => {
  const sheet = readCode("src/components/activity/TranscriptSheet.tsx");

  it("REGRESSION: overlapping polls cannot rewind the transcript", () => {
    expect(sheet).toMatch(/let inFlight: AbortController \| null = null;/);
    expect(sheet).toMatch(/inFlight\?\.abort\(\);/);
    expect(sheet).toMatch(/if \(!alive \|\| ctl\.signal\.aborted\) return;/);
  });

  it("and the interval's teardown aborts too, so closing the sheet frees the socket", () => {
    const cleanup = sheet.slice(sheet.indexOf("return () => {"));
    expect(cleanup.slice(0, cleanup.indexOf("};"))).toMatch(/inFlight\?\.abort\(\)/);
  });
});

describe("the panel's only open/close affordance stays on screen", () => {
  const page = readCode("src/app/page.tsx");

  it("REGRESSION: the counters wrap instead of clipping", () => {
    // gap-y-1 on a non-wrapping row was dead - clear evidence flex-wrap was
    // intended. The parent is overflow-hidden, so this clipped rather than
    // scrolling: "offers" cut mid-word, chevron gone.
    expect(page).toMatch(/flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1/);
    expect(page).not.toMatch(/flex w-full items-center gap-x-3 gap-y-1 px-3 py-2/);
  });

  it("the chevron is outside the wrapping group and cannot shrink", () => {
    expect(page).toMatch(/shrink-0 text-\[10px\] text-faint">\{statusOpen \? "▲" : "▼"\}/);
    expect(page).not.toMatch(/ml-auto text-\[10px\] text-faint">\{statusOpen/);
  });
});
