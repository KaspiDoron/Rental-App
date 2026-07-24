import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

// Captured inserts + scripted reads.
const state: { events: any[]; inserted: any[]; teacherText: string | null } = {
  events: [],
  inserted: [],
  teacherText: null,
};

vi.mock("./runtime-config", () => ({
  sbSelect: async (_table: string) => state.events.map((e) => ({ detail: JSON.stringify(e) })),
  sbInsert: async (_table: string, rows: any[]) => {
    state.inserted.push(...rows);
    return true;
  },
  getConfig: async () => undefined,
  setConfig: async () => ({ ok: true, persistent: false }),
}));

vi.mock("./ai", () => ({
  chatDetailed: async () => ({ text: state.teacherText, provider: "deepseek" }),
  extractJson: <T,>(t: string): T | null => {
    const s = t.indexOf("{");
    const e = t.lastIndexOf("}");
    try {
      return JSON.parse(t.slice(s, e + 1)) as T;
    } catch {
      return null;
    }
  },
}));

import { runDistillation } from "./distill";

const winTurn = (text: string) => ({ move: "bargain", materialDrop: true, text });

beforeEach(() => {
  state.events = [];
  state.inserted = [];
  state.teacherText = null;
});

describe("runDistillation - free-first DeepSeek teacher", () => {
  it("refuses with <3 winning turns and writes nothing", async () => {
    state.events = [winTurn("push for a weekly rate"), winTurn("ask one number off")];
    const r = await runDistillation();
    expect(r.written).toBe(0);
    expect(r.error).toMatch(/at least 3/i);
    expect(state.inserted).toHaveLength(0);
  });

  it("mines ONLY winning turns (materialDrop + bargain/present/answer + text)", async () => {
    state.events = [
      winTurn("anchor on the multi-day total"),
      winTurn("ask for one concrete number off"),
      winTurn("mention the other shop politely"),
      { move: "bargain", materialDrop: false, text: "no drop - ignored" }, // not a win
      { move: "silent", materialDrop: true, text: null }, // silent/no text - ignored
      { move: "close", materialDrop: true, text: "bye" }, // wrong move - ignored
    ];
    state.teacherText = JSON.stringify({
      exemplars: ["Anchor on the multi-day total, then ask for one number off the daily rate.", "Cite a rival shop warmly and ask them to beat it."],
    });
    const r = await runDistillation();
    expect(r.mined).toBe(3); // only the 3 real wins
    expect(r.written).toBe(2);
    expect(state.inserted).toHaveLength(2);
    expect(state.inserted.every((row) => row.source === "distilled")).toBe(true);
  });

  it("drops exemplars that leak a number or currency sign (tone-only rule)", async () => {
    state.events = [winTurn("first winning message"), winTurn("second winning message"), winTurn("third winning message")];
    state.teacherText = JSON.stringify({
      exemplars: [
        "Offer 250 baht and hold firm.", // has a number -> dropped
        "Ask for ฿50 off.", // currency sign -> dropped
        "Anchor on the whole-week total before naming a target.", // clean -> kept
      ],
    });
    const r = await runDistillation();
    expect(r.written).toBe(1);
    expect(state.inserted[0].text).toMatch(/whole-week total/);
  });

  it("reports the teacher error and writes nothing when no provider answers", async () => {
    state.events = [winTurn("a"), winTurn("b"), winTurn("c")];
    state.teacherText = null; // provider returned nothing
    const r = await runDistillation();
    expect(r.written).toBe(0);
    expect(state.inserted).toHaveLength(0);
  });
});
