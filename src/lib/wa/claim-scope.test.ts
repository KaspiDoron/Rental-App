import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

// OWNER REPORT 6, WAVE H - the concurrency seams, executed where they are
// pure and pinned where they are wiring.
//
// H4: claim keys were the bare provider message id, which WhatsApp does not
// promise is unique across RECEIVERS - one shop broadcast to two travellers
// dropped the second copy as a "duplicate". H2: the fromMe echo of our own
// send could outrun our outbound insert and convict us of a human takeover.
// H1: a coalescing turn consumed a whole burst but claimed only its trigger.

vi.mock("server-only", () => ({}));

const readCode = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("H4: the claim key is receiver-scoped", () => {
  beforeEach(() => vi.resetModules());

  it("scopes by account, lowercased, and passes bare ids through", async () => {
    const { claimKey } = await import("./inbound-claim");
    expect(claimKey("A@x.com", "MSG1")).toBe("a@x.com:MSG1");
    expect(claimKey(null, "MSG1")).toBe("MSG1");
    expect(claimKey("a@x.com", "")).toBe("");
  });

  it("two receivers of the same broadcast id claim independently", async () => {
    const { claimKey } = await import("./inbound-claim");
    expect(claimKey("a@x.com", "BCAST")).not.toBe(claimKey("b@x.com", "BCAST"));
  });

  it("a legacy bare-id row still counts as stored (no double-store)", async () => {
    vi.doMock("../runtime-config", () => ({
      sbSelect: vi.fn(async (_t: string, q: string) =>
        // The legacy probe asks for the BARE id - answer that it exists.
        q.includes("wa_message_id=eq.BCAST") ? [{ wa_message_id: "BCAST" }] : []
      ),
      sbInsertReturning: vi.fn(async () => [{ wa_message_id: "x" }]),
    }));
    const { claimInboundStore } = await import("./inbound-claim");
    expect(await claimInboundStore("BCAST", "a@x.com")).toBe(false);
  });

  it("every claim surface goes through the scoped key", () => {
    const loop = readCode("src/lib/agent-loop.ts");
    expect(loop).toMatch(/claimKey\(opts\.senderEmail, opts\.waMessageId\)/);
    expect(loop).toMatch(/releaseReplyClaim\(opts\.waMessageId, opts\.senderEmail\)/);
    const ingest = readCode("src/lib/wa/ingest.ts");
    expect(ingest).toMatch(/claimInboundStore\(msgId, email\)/);
    expect(ingest).toMatch(/releaseInboundStore\(msgId, email\)/);
  });
});

describe("H2: the durable send intent outruns the fromMe echo", () => {
  it("the echo path probes wa_send_claims by hash before convicting", () => {
    const ingest = readCode("src/lib/wa/ingest.ts");
    const echo = ingest.slice(ingest.indexOf("data.key.fromMe"));
    const claimProbe = echo.indexOf('sbSelectStrict(\n                  "wa_send_claims"');
    const conviction = echo.indexOf('kind: "human-manual"');
    expect(claimProbe, "the intent probe must exist on the echo path").toBeGreaterThan(0);
    expect(conviction).toBeGreaterThan(claimProbe);
    expect(echo).toMatch(/messageSlotKey\(from, text\)/);
  });
});

describe("H1: a coalescing turn claims every sibling it consumed", () => {
  it("the delivered turn claims the burst's other ids, scoped", () => {
    const loop = readCode("src/lib/agent-loop.ts");
    const at = loop.indexOf('finishBeforeResponse("claim-coalesced"');
    expect(at).toBeGreaterThan(0);
    const block = loop.slice(at, at + 600);
    expect(block).toMatch(/claimKey\(opts\.senderEmail, id\)/);
    // Consumed = inbound, inside the coalesce window, not the trigger itself.
    const gather = loop.slice(loop.indexOf("const consumed = thread"), at);
    expect(gather).toMatch(/m\.received_at > priorAt/);
    expect(gather).toMatch(/m\.wa_message_id !== opts\.waMessageId/);
  });
});
