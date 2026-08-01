import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("server-only", () => ({}));

import { outboxKey } from "./phone-key";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const readCode = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

// A MIGRATION THAT LOOKS APPLIED IS THE LEAST DEBUGGABLE KIND OF DEAD CODE.
//
// `wa_outbox.to_key` was added with a unique index and a comment explaining the
// exact bug it fixes: one shop stored as both "639661952196" and "09661952196"
// held TWO live pending rows, and a single drain sent both inside the same
// second. The DDL ran clean. Nothing ever wrote the column.
//
// With to_key always NULL the index falls back to
// `coalesce(to_key, to_number) = to_number` - character-for-character the
// exact-string behaviour it was migrated to replace - and parkOutboxOnce
// repeated the same mistake in application code, scoping its delete-then-insert
// on `to_number=eq.`. So the duplicate-suppression everyone believed was live
// had been quietly inert since the day it shipped.

describe("one shop is one key, whatever the spelling", () => {
  it("REPRODUCTION: the two spellings of one Philippine number collapse", () => {
    expect(outboxKey("639661952196")).toBe(outboxKey("09661952196"));
  });

  it("...and formatting never changes the answer", () => {
    expect(outboxKey("+66 93 103 4552")).toBe(outboxKey("66931034552"));
    expect(outboxKey("+66-93-103-4552")).toBe(outboxKey("0931034552"));
  });

  it("different shops stay different", () => {
    expect(outboxKey("66931034552")).not.toBe(outboxKey("66812345678"));
  });

  it("a number too short for a national tail still yields a usable key", () => {
    expect(outboxKey("12345")).toBe("12345");
    expect(outboxKey("")).toBe("");
  });
});

describe("every write stamps it, and the scope reads it", () => {
  it("parkOutboxOnce scopes on the shop, not on the spelling", () => {
    const park = readCode("src/lib/wa/park.ts");
    expect(park).toMatch(/const key = outboxKey\(row\.toNumber\)/);
    expect(park).toMatch(/to_key=eq\.\$\{encodeURIComponent\(\s*key\s*\)\}/);
    expect(park).toMatch(/to_key: key,/);
    // The exact-string scope that made this function unable to do its job.
    expect(park).not.toMatch(/to_number=eq\.\$\{encodeURIComponent\(\s*row\.toNumber\s*\)\}/);
  });

  it("every wa_outbox insert site stamps to_key", () => {
    const files = [
      "src/lib/graph/engine.ts",
      "src/lib/wa-guard.ts",
      "src/app/api/outreach/route.ts",
      "src/app/api/outreach/mass/route.ts",
    ];
    for (const f of files) {
      const code = readCode(f);
      const inserts = code.split(`sbInsert("wa_outbox", [`).slice(1);
      expect(inserts.length).toBeGreaterThan(0);
      for (const chunk of inserts) {
        // The record literal ends well within 400 chars of the insert call.
        expect(chunk.slice(0, 400)).toMatch(/to_key: outboxKey\(/);
      }
    }
  });
});

describe("and the schema stops pretending", () => {
  it("the objects whose code never followed are marked as such", () => {
    const schema = read("supabase/schema.sql");
    expect(schema).toMatch(/SHIPPED AHEAD OF THEIR CODE, AND THE CODE/);
    expect(schema).toMatch(/wa_outbox\.to_key\s+- NOW WRITTEN/);
    expect(schema).toMatch(/dedupe_key - SUPERSEDED/);
    expect(schema).toMatch(/wa_turns\s+- SUPERSEDED/);
    expect(schema).toMatch(/wa_thread_locks\s+- SUPERSEDED/);
  });
});
