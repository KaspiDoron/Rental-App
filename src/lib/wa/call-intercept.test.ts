import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("server-only", () => ({}));

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

// What the world does in response to a call.
const world: {
  known: string | null;
  claim: "won" | "lost" | "error";
  pushes: { title: string; url: string; tag?: string }[];
  sends: { to: string; text: string; auto: boolean }[];
  /** What actually reached the TRANSPORT - the reproduction's whole point. */
  transported: { to: string; text: string; lane?: string }[];
  events: { kind: string; vendor: string }[];
} = { known: null, claim: "won", pushes: [], sends: [], transported: [], events: [] };

vi.mock("./known-thread", () => ({
  resolveKnownThreadNumber: async (_e: string, digits: string) =>
    world.known === null ? null : world.known || digits,
}));
vi.mock("../runtime-config", () => ({
  sbInsertClaim: async () => world.claim,
  sbInsert: async (table: string, rows: { kind: string; vendor_name: string }[]) => {
    if (table === "agent_events") world.events.push({ kind: rows[0].kind, vendor: rows[0].vendor_name });
    return true;
  },
}));
vi.mock("../notify/state", () => ({
  notifyState: async () => ({ anyReplyYet: true, sentInWindow: 99 }),
  markPushSent: async () => {},
}));
vi.mock("../push", () => ({
  sendPushToUser: async (_e: string, p: { title: string; url: string; tag?: string }) => {
    world.pushes.push(p);
  },
}));
vi.mock("../wa-guard", () => ({
  guardOutbound: async (o: { toDigits: string; text: string; auto: boolean }) => {
    world.sends.push({ to: o.toDigits, text: o.text, auto: o.auto });
    return { allow: true, text: o.text };
  },
  claimForSend: async () => ({ ok: true }),
  releaseSendClaim: async () => {},
  afterSend: async () => {},
}));
vi.mock("../evolution", () => ({
  sendFromUser: async (_e: string, to: string, text: string, _fast: boolean, o?: { lane?: string }) => {
    world.transported.push({ to, text, lane: o?.lane });
    return { ok: true, messageId: "m1" };
  },
}));

import { handleCallEvent, parseCallFrame, isRinging, missedCallReply } from "./call-intercept";

const SHOP = "66123456789";
const offer = (extra: Record<string, unknown> = {}) => ({ from: `${SHOP}@s.whatsapp.net`, status: "offer", ...extra });

beforeEach(() => {
  world.known = SHOP;
  world.claim = "won";
  world.pushes = [];
  world.sends = [];
  world.transported = [];
  world.events = [];
});

describe("reading Evolution's call frame", () => {
  it("the caller is found whichever field the build uses", () => {
    expect(parseCallFrame({ from: `${SHOP}@s.whatsapp.net` })?.fromDigits).toBe(SHOP);
    expect(parseCallFrame({ chatId: `${SHOP}@c.us` })?.fromDigits).toBe(SHOP);
    expect(parseCallFrame({ peerJid: SHOP })?.fromDigits).toBe(SHOP);
    // Arrays are as common as objects across builds.
    expect(parseCallFrame([{ from: SHOP }])?.fromDigits).toBe(SHOP);
  });

  it("a frame with no caller is not a call", () => {
    expect(parseCallFrame({ status: "offer" })).toBeNull();
    expect(parseCallFrame(null)).toBeNull();
    expect(parseCallFrame("nope")).toBeNull();
  });

  it("only the OFFER is news - the hangup is not a second call", () => {
    expect(isRinging({ fromDigits: SHOP, isVideo: false, status: "offer" })).toBe(true);
    expect(isRinging({ fromDigits: SHOP, isVideo: false, status: "terminate" })).toBe(false);
    expect(isRinging({ fromDigits: SHOP, isVideo: false, status: "reject" })).toBe(false);
    // A build that sends no status only ever emits offers.
    expect(isRinging({ fromDigits: SHOP, isVideo: false, status: null })).toBe(true);
  });
});

describe("a shop rings: the traveller hears about it and the shop gets an answer", () => {
  it("REPRODUCTION: a call now produces a push AND a reply", () => {
    return handleCallEvent({ email: "t@example.com", data: offer() }).then((r) => {
      expect(r.outcome).toBe("answered");
      expect(world.pushes[0].title).toMatch(/calling you/);
      expect(world.pushes[0].url).toBe(`/?from=${SHOP}`);
      expect(world.sends[0].to).toBe(SHOP);
      expect(world.sends[0].text).toMatch(/can'?t (take|really do) a? ?calls?/i);
      // REPRODUCTION of the 3.4 defect: a guard verdict is a DECISION, not a
      // delivery. The message must reach the transport, on the reply lane.
      expect(world.transported[0]).toMatchObject({ to: SHOP, lane: "reply" });
    });
  });

  it("the push is NOT budgeted - a ringing phone cannot wait for a window", async () => {
    // notifyState above reports 99 pushes already sent in this window, which
    // silences every ordinary kind. A call still gets through.
    await handleCallEvent({ email: "t@example.com", data: offer() });
    expect(world.pushes.length).toBe(1);
  });

  it("...and it has its own tag, so a reply push cannot collapse it away", async () => {
    await handleCallEvent({ email: "t@example.com", data: offer() });
    expect(world.pushes[0].tag).toBe(`call:${SHOP}`);
  });

  it("a video call says so - it is a different thing to answer", async () => {
    await handleCallEvent({ email: "t@example.com", data: offer({ isVideo: true }) });
    expect(world.pushes[0].title).toMatch(/video-calling/);
  });

  it("the reply goes through the ORDINARY guarded path", async () => {
    // Urgent to the traveller is not a licence to bypass pacing or the mutex.
    await handleCallEvent({ email: "t@example.com", data: offer() });
    expect(world.sends[0].auto).toBe(true);
    const code = readCode("src/lib/wa/call-intercept.ts");
    expect(code).toMatch(/queueIfBlocked: true/);
  });

  it("and Ops can see it happened", async () => {
    await handleCallEvent({ email: "t@example.com", data: offer() });
    expect(world.events[0]).toEqual({ kind: "inbound-call", vendor: SHOP });
  });
});

describe("THE PRIVACY GATE holds, exactly as it does for messages", () => {
  it("REPRODUCTION: a call from a number we never messaged is not ours", async () => {
    world.known = null;
    const r = await handleCallEvent({ email: "t@example.com", data: offer() });
    expect(r.outcome).toBe("not-ours");
    // No notification, and above all no message about a motorbike to whoever
    // that actually was.
    expect(world.pushes).toEqual([]);
    expect(world.sends).toEqual([]);
  });

  it("no signed-in user for this instance: nothing happens at all", async () => {
    const r = await handleCallEvent({ email: null, data: offer() });
    expect(r.outcome).toBe("no-user");
    expect(world.sends).toEqual([]);
  });
});

describe("a shop that redials four times is still one conversation", () => {
  it("the second call this hour does not send a second message", async () => {
    world.claim = "lost";
    const r = await handleCallEvent({ email: "t@example.com", data: offer() });
    expect(r.outcome).toBe("ignored");
    expect(world.sends).toEqual([]);
    // The traveller is STILL told - the phone is ringing right now, whatever
    // we said to the shop an hour ago.
    expect(world.pushes.length).toBe(1);
  });

  it("a claims outage fails OPEN - one extra polite message beats silence", async () => {
    world.claim = "error";
    const r = await handleCallEvent({ email: "t@example.com", data: offer() });
    expect(r.outcome).toBe("answered");
    expect(world.sends.length).toBe(1);
    expect(world.transported.length).toBe(1);
  });
});

describe("the reply is deterministic on purpose", () => {
  it("every variant says the same three things", () => {
    for (let i = 0; i < 3; i++) {
      const text = missedCallReply(() => i / 3);
      expect(text).toMatch(/sorry/i);
      expect(text.toLowerCase()).toMatch(/can'?t|couldn'?t/);
      expect(text).toMatch(/here|message/i);
    }
  });

  it("no variant commits to anything or names a price", () => {
    for (let i = 0; i < 3; i++) {
      const text = missedCallReply(() => i / 3);
      expect(text).not.toMatch(/\d/);
      expect(text).not.toMatch(/\b(take it|book|reserve|deal)\b/i);
    }
  });
});

describe("the event is subscribed to, and reaches the handler", () => {
  it("CALL is in the ONE event list all three call sites use", () => {
    const evo = readCode("src/lib/evolution.ts");
    expect(evo).toMatch(/const WEBHOOK_EVENTS = \[[\s\S]*"CALL",[\s\S]*\] as const;/);
    // Three literals that only matched because nobody had edited one lately.
    expect(evo).not.toMatch(/\["MESSAGES_UPSERT", "MESSAGES_UPDATE", "CONNECTION_UPDATE"\]/);
  });

  it("the webhook dispatches it, awaited", () => {
    const ingest = readCode("src/lib/wa/ingest.ts");
    expect(ingest).toMatch(/if \(event\.includes\("call"\)\) \{/);
    expect(ingest).toMatch(/finishBeforeResponse\("inbound-call", \(\) => handleCallEvent/);
  });
});
