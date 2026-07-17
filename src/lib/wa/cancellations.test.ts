import { describe, it, expect, vi, beforeEach } from "vitest";

// The absolute-cancellation contract: a removed shop is NEVER auto-messaged
// again, a missing (un-migrated) table is vacuously "not cancelled", and a
// transient read failure is UNKNOWN (null) so senders fail CLOSED.

vi.mock("server-only", () => ({}));

const state: {
  rows: { sender_key: string; to_number: string }[];
  strictMode: "ok" | "missing" | "unavailable";
  config: Record<string, string | undefined>;
  inserts: { table: string; rows: Record<string, unknown>[]; onConflict?: string }[];
  deletes: { table: string; query: string }[];
} = { rows: [], strictMode: "ok", config: {}, inserts: [], deletes: [] };

vi.mock("../runtime-config", () => ({
  getConfig: async (k: string) => state.config[k],
  sbInsert: async (table: string, rows: Record<string, unknown>[], onConflict?: string) => {
    state.inserts.push({ table, rows, onConflict });
    if (state.strictMode === "unavailable") return false;
    if (state.strictMode === "missing") return false;
    for (const r of rows) {
      state.rows.push({ sender_key: String(r.sender_key), to_number: String(r.to_number) });
    }
    return true;
  },
  sbDelete: async (table: string, query: string) => {
    state.deletes.push({ table, query });
  },
  sbSelectStrict: async (_table: string, query: string) => {
    if (state.strictMode === "missing") return { error: "missing" as const };
    if (state.strictMode === "unavailable") return { error: "unavailable" as const };
    const sender = decodeURIComponent(/sender_key=eq\.([^&]+)/.exec(query)?.[1] ?? "");
    const to = decodeURIComponent(/to_number=eq\.([^&]+)/.exec(query)?.[1] ?? "");
    const rows = state.rows.filter(
      (r) => r.sender_key === sender && (!to || r.to_number === to)
    );
    return { rows };
  },
}));

import {
  cancelSends,
  clearCancellation,
  isCancelled,
  cancelledNumbers,
} from "./cancellations";

beforeEach(() => {
  state.rows = [];
  state.strictMode = "ok";
  state.config = {};
  state.inserts = [];
  state.deletes = [];
});

describe("cancellation tombstones", () => {
  it("cancel -> isCancelled true; clear -> re-checkable via a fresh explicit action", async () => {
    expect(await cancelSends("a@x.com", "+66 81-234 5678", "user-removed")).toBe(true);
    // Numbers are normalized to digits at write AND read.
    expect(await isCancelled("a@x.com", "66812345678")).toBe(true);
    expect(await isCancelled("a@x.com", "+66 81 234 5678")).toBe(true);
    // Another user's identical shop number is unaffected.
    expect(await isCancelled("b@x.com", "66812345678")).toBe(false);

    await clearCancellation("a@x.com", "66812345678");
    const del = state.deletes.find((d) => d.table === "wa_cancellations");
    expect(del?.query).toContain("sender_key=eq.a%40x.com");
    expect(del?.query).toContain("to_number=eq.66812345678");
  });

  it("upserts on (sender, number) so re-cancelling never errors", async () => {
    await cancelSends("a@x.com", "66812345678", "user-removed");
    expect(state.inserts[0].onConflict).toBe("sender_key,to_number");
  });

  it("missing table (schema not migrated) reads as NOT cancelled - vacuous truth", async () => {
    state.strictMode = "missing";
    expect(await isCancelled("a@x.com", "66812345678")).toBe(false);
  });

  it("transient failure reads as UNKNOWN (null) - callers must fail closed", async () => {
    state.rows.push({ sender_key: "a@x.com", to_number: "66812345678" });
    state.strictMode = "unavailable";
    expect(await isCancelled("a@x.com", "66812345678")).toBe(null);
  });

  it("CANCEL_GUARD=off disables enforcement but writes keep flowing", async () => {
    await cancelSends("a@x.com", "66812345678", "user-removed");
    state.config.CANCEL_GUARD = "off";
    expect(await isCancelled("a@x.com", "66812345678")).toBe(false);
    // The tombstone row still exists - flipping the switch back restores it.
    state.config.CANCEL_GUARD = undefined;
    expect(await isCancelled("a@x.com", "66812345678")).toBe(true);
  });

  it("cancelSends reports failure honestly (route must not claim permanence)", async () => {
    state.strictMode = "unavailable";
    expect(await cancelSends("a@x.com", "66812345678", "user-removed")).toBe(false);
  });

  it("cancelledNumbers lists only this user's tombstones", async () => {
    await cancelSends("a@x.com", "111", "user-removed");
    await cancelSends("a@x.com", "222", "session-closed");
    await cancelSends("b@x.com", "333", "user-removed");
    expect((await cancelledNumbers("a@x.com")).sort()).toEqual(["111", "222"]);
  });
});
