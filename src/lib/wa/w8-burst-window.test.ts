import { describe, it, expect, vi, beforeEach } from "vitest";

// W8 A1: AN IMAGE BURST SILENTLY LOST EVERY FRAME, INCLUDING ITS OWN.
//
// `siblingFrames` re-queried a SLIDING window (`received_at >= now - 6s`) three
// separate times. Between query 1 and query 3 the caller does a media download
// (with retries) and then sleeps DEFER_MS (4s) waiting for stragglers - so by
// the last query the frame's OWN row had usually aged out of its own 6-second
// window.
//
// What happened then is the ugly part. `newerSibling` finds no `own` row and
// correctly refuses to stand down ("never stand down blind"), so the frame
// proceeds as leader - and then assembles from a `rows` array that contains
// neither it nor any sibling. A five-photo price board reached the reader as
// ZERO frames, reported as a burst of zero, with no error anywhere.
//
// The window is now anchored on the LEADER's received_at, so it names the same
// set of rows however long the fetch and the defer take.

const db = vi.hoisted(() => ({
  /** Every row the store holds, whatever the window. */
  all: [] as Array<Record<string, unknown>>,
  /** Fake wall clock, advanced by the injected fetch/sleep. */
  now: 0,
  /** The `since` bound of each query, in order - the assertion surface. */
  windows: [] as string[],
}));

vi.mock("server-only", () => ({}));
vi.mock("../runtime-config", () => ({
  // A store that actually honours the window the caller asked for. The old
  // test double returned every row regardless, which is exactly why a sliding
  // window looked correct under test and lost whole albums in production.
  sbSelect: vi.fn(async (_table: string, query: string) => {
    const m = /received_at=gte\.([^&]+)/.exec(query);
    const since = m ? decodeURIComponent(m[1]) : "";
    db.windows.push(since);
    return db.all.filter((r) => String(r.received_at) >= since);
  }),
}));

import { assembleImageBurst, burstWindowSince, burstAnchor } from "./image-burst";

const T0 = Date.parse("2026-08-15T10:00:00.000Z");

const frame = (id: number, msgId: string, atMs: number) => ({
  id,
  wa_message_id: msgId,
  received_at: new Date(atMs).toISOString(),
  type: "image",
  raw: { media: { key: { id: msgId }, kind: "image", mime: "image/jpeg" } },
});

const bytes = (tag: string) => ({ mime: "image/jpeg", base64: `b64-${tag}` });

beforeEach(() => {
  db.all = [];
  db.now = T0;
  db.windows = [];
  vi.spyOn(Date, "now").mockImplementation(() => db.now);
});

describe("W8 A1: the burst window is anchored on the leader, not on the clock", () => {
  // A five-frame album that landed over 1.2 seconds. The leader is m-14.
  const album = () => [
    frame(10, "m-10", T0 - 1200),
    frame(11, "m-11", T0 - 900),
    frame(12, "m-12", T0 - 600),
    frame(13, "m-13", T0 - 300),
    frame(14, "m-14", T0),
  ];

  it("REPRODUCTION: a slow fetch plus the 4s defer used to empty the window", async () => {
    // The exact production timing: the media download takes ~3s (retries on a
    // waking Evolution host) and the defer adds 4s. Seven seconds after the
    // leader arrived, a `now - 6s` window contains NOTHING - not one album
    // frame, not even the leader's own row.
    db.all = album();
    const slidingSince = burstWindowSince(null, T0 + 7000);
    expect(db.all.filter((r) => String(r.received_at) >= slidingSince)).toHaveLength(0);
  });

  it("the anchored window still names the whole album seven seconds later", () => {
    db.all = album();
    const anchored = burstWindowSince(burstAnchor(album(), "m-14"), T0 + 7000);
    expect(db.all.filter((r) => String(r.received_at) >= anchored)).toHaveLength(5);
  });

  it("EXECUTED: the leader assembles all five frames despite a slow fetch and the defer", async () => {
    db.all = album();
    const v = await assembleImageBurst({
      email: "u@x.com",
      fromDigits: "66111",
      ownMsgId: "m-14",
      fetchOwn: async () => {
        db.now += 3000; // a slow media download, with retries
        return bytes("own");
      },
      fetchByKey: async (key) => bytes((key as { id: string }).id),
      sleep: async (ms) => {
        db.now += ms; // the 4s straggler defer
      },
    });
    expect(v.standDown).toBe(false);
    if (!v.standDown) {
      expect(v.frames.map((f) => f.waMessageId)).toEqual([
        "m-10",
        "m-11",
        "m-12",
        "m-13",
        "m-14",
      ]);
      expect(v.burstSize).toBe(5);
      expect(v.fetchFailures).toBe(0);
    }
    // Every probe after the first asked the SAME question.
    expect(new Set(db.windows.slice(1)).size).toBe(1);
    expect(db.windows[1]).toBe(burstWindowSince(new Date(T0).toISOString(), T0));
  });

  it("a straggler arriving after the anchor is still seen - the window has no upper bound", async () => {
    db.all = album();
    const v = await assembleImageBurst({
      email: "u@x.com",
      fromDigits: "66111",
      ownMsgId: "m-14",
      fetchOwn: async () => bytes("own"),
      fetchByKey: async () => bytes("sib"),
      sleep: async (ms) => {
        db.now += ms;
        db.all.push(frame(15, "m-15", db.now)); // out-of-order webhook lands
      },
    });
    expect(v).toEqual({ standDown: true, leaderId: "m-15" });
  });

  it("bytes we already hold are never thrown away because a LISTING failed", async () => {
    // siblingFrames swallows read errors and returns []. That must cost the
    // siblings, never the frame we are actually processing.
    db.all = [];
    const v = await assembleImageBurst({
      email: "u@x.com",
      fromDigits: "66111",
      ownMsgId: "m-99",
      fetchOwn: async () => bytes("own"),
      fetchByKey: async () => null,
      sleep: async () => {},
    });
    expect(v.standDown).toBe(false);
    if (!v.standDown) {
      expect(v.frames).toEqual([{ ...bytes("own"), waMessageId: "m-99" }]);
      expect(v.ownFetchFailed).toBe(false);
    }
  });

  it("no anchor (our row is not visible) falls back to the sliding window", () => {
    expect(burstAnchor(album(), "m-not-here")).toBeNull();
    expect(burstWindowSince(null, T0)).toBe(new Date(T0 - 6000).toISOString());
  });
});
