import { describe, it, expect, vi, beforeEach } from "vitest";

// The absolute-cancellation contract, v2: a removed shop is NEVER auto-
// messaged again - and that guarantee must hold BEFORE the schema migration
// runs (marker rows in the always-existing messages table carry the
// tombstone), AFTER it (table + markers agree), and across the transition
// (an empty new table must not silently reopen marker-cancelled shops).

vi.mock("server-only", () => ({}));

interface MarkerRow {
  sender: string;
  digits: string;
  kind: string;
  at: number;
}

const state: {
  tableRows: { sender_key: string; to_number: string }[];
  markers: MarkerRow[];
  // per-table availability: "ok" | "missing" | "unavailable"
  cancellationsMode: "ok" | "missing" | "unavailable";
  messagesMode: "ok" | "missing" | "unavailable";
  config: Record<string, string | undefined>;
  clock: number;
} = {
  tableRows: [],
  markers: [],
  cancellationsMode: "ok",
  messagesMode: "ok",
  config: {},
  clock: 1_700_000_000_000,
};

vi.mock("../runtime-config", () => ({
  getConfig: async (k: string) => state.config[k],
  sbInsert: async (table: string, rows: Record<string, unknown>[]) => {
    if (table === "wa_cancellations") {
      if (state.cancellationsMode !== "ok") return false;
      for (const r of rows) {
        state.tableRows = state.tableRows.filter(
          (x) => !(x.sender_key === r.sender_key && x.to_number === r.to_number)
        );
        state.tableRows.push({ sender_key: String(r.sender_key), to_number: String(r.to_number) });
      }
      return true;
    }
    if (table === "whatsapp_messages") {
      if (state.messagesMode !== "ok") return false;
      for (const r of rows) {
        const raw = r.raw as { sender?: string; digits?: string; kind?: string };
        state.markers.push({
          sender: String(raw.sender),
          digits: String(raw.digits),
          kind: String(raw.kind),
          at: state.clock++,
        });
      }
      return true;
    }
    return true;
  },
  sbDelete: async (table: string, query: string) => {
    if (table !== "wa_cancellations") return;
    const sender = decodeURIComponent(/sender_key=eq\.([^&]+)/.exec(query)?.[1] ?? "");
    const to = decodeURIComponent(/to_number=eq\.([^&]+)/.exec(query)?.[1] ?? "");
    state.tableRows = state.tableRows.filter(
      (r) => !(r.sender_key === sender && (!to || r.to_number === to))
    );
  },
  sbSelectStrict: async (table: string, query: string) => {
    if (table === "wa_cancellations") {
      if (state.cancellationsMode !== "ok") return { error: state.cancellationsMode };
      const sender = decodeURIComponent(/sender_key=eq\.([^&]+)/.exec(query)?.[1] ?? "");
      const to = decodeURIComponent(/to_number=eq\.([^&]+)/.exec(query)?.[1] ?? "");
      return {
        rows: state.tableRows
          .filter((r) => r.sender_key === sender && (!to || r.to_number === to))
          .map((r) => ({ id: 1, to_number: r.to_number })),
      };
    }
    if (table === "whatsapp_messages") {
      if (state.messagesMode !== "ok") return { error: state.messagesMode };
      const sender = decodeURIComponent(/raw->>sender=eq\.([^&]+)/.exec(query)?.[1] ?? "");
      const digits = decodeURIComponent(/raw->>digits=eq\.([^&]+)/.exec(query)?.[1] ?? "");
      const rows = state.markers
        .filter((m) => m.sender === sender && (!digits || m.digits === digits))
        .sort((a, b) => b.at - a.at)
        .map((m) => ({ raw: { sender: m.sender, digits: m.digits, kind: m.kind } }));
      return { rows };
    }
    return { rows: [] };
  },
}));

import {
  cancelSends,
  clearCancellation,
  isCancelled,
  cancelledNumbers,
} from "./cancellations";

beforeEach(() => {
  state.tableRows = [];
  state.markers = [];
  state.cancellationsMode = "ok";
  state.messagesMode = "ok";
  state.config = {};
});

describe("cancellation tombstones (table + marker trail)", () => {
  it("cancel -> cancelled; explicit clear -> re-opened", async () => {
    expect(await cancelSends("a@x.com", "+66 81-234 5678", "user-removed")).toBe(true);
    expect(await isCancelled("a@x.com", "66812345678")).toBe(true);
    expect(await isCancelled("b@x.com", "66812345678")).toBe(false); // other user unaffected
    await clearCancellation("a@x.com", "66812345678");
    expect(await isCancelled("a@x.com", "66812345678")).toBe(false);
  });

  it("PRE-MIGRATION: works entirely on markers when the table is missing", async () => {
    state.cancellationsMode = "missing";
    expect(await cancelSends("a@x.com", "66812345678", "user-removed")).toBe(true);
    expect(await isCancelled("a@x.com", "66812345678")).toBe(true);
    await clearCancellation("a@x.com", "66812345678");
    expect(await isCancelled("a@x.com", "66812345678")).toBe(false);
    expect(await cancelledNumbers("a@x.com")).toEqual([]);
  });

  it("MIGRATION TRANSITION: a marker-cancelled shop stays cancelled after the empty table appears", async () => {
    state.cancellationsMode = "missing";
    await cancelSends("a@x.com", "66812345678", "user-removed");
    state.cancellationsMode = "ok"; // the owner just ran schema.sql - table empty
    expect(await isCancelled("a@x.com", "66812345678")).toBe(true);
    expect(await cancelledNumbers("a@x.com")).toEqual(["66812345678"]);
  });

  it("BOTH stores unreadable -> UNKNOWN (null): senders must fail closed", async () => {
    state.tableRows.push({ sender_key: "a@x.com", to_number: "66812345678" });
    state.cancellationsMode = "unavailable";
    state.messagesMode = "unavailable";
    expect(await isCancelled("a@x.com", "66812345678")).toBe(null);
  });

  it("table unavailable but markers readable and empty -> still UNKNOWN (the table may hold the tombstone)", async () => {
    state.cancellationsMode = "unavailable";
    expect(await isCancelled("a@x.com", "66812345678")).toBe(null);
  });

  it("CANCEL_GUARD=off disables enforcement; flipping back restores it", async () => {
    await cancelSends("a@x.com", "66812345678", "user-removed");
    state.config.CANCEL_GUARD = "off";
    expect(await isCancelled("a@x.com", "66812345678")).toBe(false);
    state.config.CANCEL_GUARD = undefined;
    expect(await isCancelled("a@x.com", "66812345678")).toBe(true);
  });

  it("cancelSends reports failure only when NO durable store confirmed", async () => {
    state.cancellationsMode = "unavailable";
    state.messagesMode = "unavailable";
    expect(await cancelSends("a@x.com", "66812345678", "user-removed")).toBe(false);
    state.messagesMode = "ok"; // marker path recovers -> success
    expect(await cancelSends("a@x.com", "66812345678", "user-removed")).toBe(true);
  });

  it("cancelledNumbers merges the table and the marker trail", async () => {
    await cancelSends("a@x.com", "111", "user-removed");
    state.cancellationsMode = "missing";
    await cancelSends("a@x.com", "222", "session-closed");
    state.cancellationsMode = "ok";
    expect((await cancelledNumbers("a@x.com")).sort()).toEqual(["111", "222"]);
  });
});
