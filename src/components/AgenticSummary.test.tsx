import { describe, it, expect } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageBubble, type ThreadMsg } from "./MessageBubble";
import { readingFrom } from "../lib/media/reading";

// The harness compiles JSX with the classic runtime, which emits bare
// `React.createElement`; the app builds with Next's automatic runtime.
// Publishing React globally lets both render here unchanged.
(globalThis as Record<string, unknown>).React = React;

// A PHOTO WITH NOTHING UNDERNEATH IT.
//
// The owner's report, verbatim: one image menu got no explanation panel at all.
// The cause was one line - the picture rendered on `m.media`, the panel on
// `m.media && m.reading` - so any turn that failed to stamp a reading (a
// missing inbound row, a throw inside the stamp, a burst follower that never
// got one) degraded to complete silence. Silence is the one thing a proof
// surface may never be: it is indistinguishable from "still working", from "we
// are blind", and from "the panel itself is broken".
//
// The old guard was pinned by a source-text assertion in reading.test.ts, which
// is exactly why it survived the field report. These RENDER the bubble.

const now = Date.now();
const iso = (msAgo: number) => new Date(now - msAgo).toISOString();

const bubble = (m: Partial<ThreadMsg>) =>
  renderToStaticMarkup(
    <MessageBubble
      m={{
        id: "i1",
        dir: "in",
        text: "[photo]",
        at: iso(2_000),
        media: { id: "wa-1", kind: "image" },
        ...m,
      }}
    />
  );

/** The panel's collapsed row is the only button carrying aria-expanded. */
const hasPanel = (html: string) => html.includes("aria-expanded");

describe("every image row explains itself, with or without a reading", () => {
  it("THE REGRESSION: a photo with NO reading is not silent", () => {
    const html = bubble({ reading: undefined });
    expect(html).toContain("wa-1"); // the picture is there...
    expect(hasPanel(html)).toBe(true); // ...and so is the explanation
    expect(html).toMatch(/Reading this photo/);
  });

  it("a photo we did read still renders its reading, unchanged", () => {
    const html = bubble({
      reading: readingFrom({
        imageSummary: "Board: CLICK 125cc 250B/day",
        options: [{ pricePerDay: 250, currency: "THB" }],
      }),
    });
    expect(hasPanel(html)).toBe(true);
    expect(html).toMatch(/1 price/);
    expect(html).not.toMatch(/Reading this photo/);
  });

  it("a FAILED read is explained rather than hidden - the honest state", () => {
    const html = bubble({
      reading: readingFrom({ imageRead: { seen: false, failure: "rate-limit" } }),
    });
    expect(hasPanel(html)).toBe(true);
    expect(html).toMatch(/Could not read this one yet/);
  });

  it("a voice note is NOT promised a reading it will never get", () => {
    // Audio never reaches the image reader; a "still reading" row under a voice
    // note would be a brand-new false claim in place of the old one.
    const html = bubble({ media: { id: "wa-2", kind: "audio" }, reading: undefined });
    expect(hasPanel(html)).toBe(false);
  });

  it("a text-only message has no panel at all", () => {
    const html = bubble({ media: undefined, text: "250 baht per day" });
    expect(hasPanel(html)).toBe(false);
    expect(html).toContain("250 baht per day");
  });
});
