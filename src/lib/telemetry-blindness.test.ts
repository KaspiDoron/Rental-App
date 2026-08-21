import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("server-only", () => ({}));

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

// OWNER REPORT 7, P1 (I4): A SILENT PANEL AND A QUIET SYSTEM LOOK IDENTICAL.
//
// Every telemetry write is `.catch(() => {})` on purpose - a failed trace must
// never break a real turn. The cost is that a Supabase blip silences all the
// panels at once, and the owner then reads "no drops today" when the truth is
// "nothing could be written today". The blindness itself is now countable.

describe("failed telemetry writes are counted, not just swallowed", () => {
  beforeEach(() => {
    vi.resetModules();
    delete (globalThis as { __wd_lost_telemetry__?: unknown }).__wd_lost_telemetry__;
  });

  it("a clean instance reports zero, honestly", async () => {
    const { lostTelemetryWrites } = await import("./runtime-config");
    expect(lostTelemetryWrites()).toEqual({ count: 0, lastAt: null });
  });

  it("THE REGRESSION: a failed agent_events insert increments the counter", async () => {
    vi.stubEnv("SUPABASE_URL", "https://stub.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "stub-key");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
    try {
      const { sbInsert, lostTelemetryWrites } = await import("./runtime-config");
      expect(await sbInsert("agent_events", [{ kind: "x" }])).toBe(false);
      expect(lostTelemetryWrites().count).toBe(1);
      expect(lostTelemetryWrites().lastAt).toBeTruthy();
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  it("a thrown write counts too - that is the outage shape", async () => {
    vi.stubEnv("SUPABASE_URL", "https://stub.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "stub-key");
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("network down");
    }));
    try {
      const { sbInsert, lostTelemetryWrites } = await import("./runtime-config");
      await sbInsert("agent_traces", [{ kind: "x" }]);
      expect(lostTelemetryWrites().count).toBe(1);
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  it("only TELEMETRY tables count - a failed business write is a different alarm", async () => {
    // Counting whatsapp_messages here would turn one number into two meanings.
    vi.stubEnv("SUPABASE_URL", "https://stub.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "stub-key");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
    try {
      const { sbInsert, lostTelemetryWrites } = await import("./runtime-config");
      await sbInsert("whatsapp_messages", [{ body: "hi" }]);
      await sbInsert("wa_outbox", [{ body: "hi" }]);
      expect(lostTelemetryWrites().count).toBe(0);
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  it("a SUCCESSFUL write never inflates it", async () => {
    vi.stubEnv("SUPABASE_URL", "https://stub.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "stub-key");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 201 })));
    try {
      const { sbInsert, lostTelemetryWrites } = await import("./runtime-config");
      expect(await sbInsert("agent_events", [{ kind: "x" }])).toBe(true);
      expect(lostTelemetryWrites().count).toBe(0);
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  it("the health route actually reports it", () => {
    const route = read("src/app/api/admin/health/route.ts");
    expect(route).toMatch(/lostTelemetryWrites: lostTelemetryWrites\(\)/);
    expect(route).toMatch(/sbCountDark, lostTelemetryWrites \} = await import/);
  });
});
