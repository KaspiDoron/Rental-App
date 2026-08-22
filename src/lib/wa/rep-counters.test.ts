import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const readCode = (p: string) =>
  read(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

// THE GAUGE THAT UNDER-COUNTS READS HEALTHY.
//
// Every safety counter on whatsapp_number_reputation was written
// read-modify-write: read `sent_total`, add one, PATCH the absolute value back.
// Two writers for the same sender - an inbound reply landing while an outbound
// send completes - both read N and both write N+1. One increment is gone.
//
// These are not statistics. They are the numerator and denominator of
// computeRisk (which auto-pauses a number at the risk threshold) and of the
// delivery-rate breaker. A 50-user beta produces this race continuously.

describe("counters are deltas, applied in the database", () => {
  const guard = readCode("src/lib/wa-guard.ts");

  it("no counter is still computed as an absolute in the app", () => {
    for (const col of [
      "sent_total",
      "replies_total",
      "blocks_total",
      "fails_total",
      "reads_total",
      "delivered_total",
      "invalid_numbers_total",
    ]) {
      // The exact shape that loses increments: `col: (rep.col || 0) + 1`.
      expect(guard).not.toMatch(new RegExp(`${col}:\\s*\\(rep\\.${col}`));
    }
  });

  it("every counting call site passes a delta instead", () => {
    expect(guard).toMatch(/\{ replies_total: 1 \}/);
    expect(guard).toMatch(/\{ reads_total: 1 \}/);
    expect(guard).toMatch(/\{ delivered_total: 1 \}/);
    expect(guard).toMatch(/\{ blocks_total: 1 \}/);
    expect(guard).toMatch(/\{ fails_total: 1 \}/);
    expect(guard).toMatch(/\{ invalid_numbers_total: 1 \}/);
    expect(guard).toMatch(/sent_total: 1/);
  });

  it("the day roll always sends its delta, even as a zero", () => {
    // wa_rep_bump's reset branch keys on the column being bumped AT ALL. With
    // the key absent, a send on a new day stamps today's DATE beside
    // yesterday's COUNT - which reads as a full day already spent.
    expect(guard).toMatch(/new_contacts_today: newContact \? 1 : 0/);
    // ...and the date rides the last-write-wins half, which is what the reset
    // branch compares against.
    expect(guard).toMatch(/new_contacts_date: today/);
  });

  it("risk is judged on where the counters are GOING, not where they were", () => {
    // Otherwise the send that crosses the threshold is scored on the state
    // before it happened and the auto-pause arrives one event late.
    expect(guard).toMatch(/const projected: Reputation = \{ \.\.\.current, \.\.\.patch \}/);
    expect(guard).toMatch(/projected\[key\] = \(\(Number\(current\[key\]\) \|\| 0\) \+ Number\(d\)\)/);
    expect(guard).toMatch(/computeRisk\(rep, p, \{ blocks7d/);
  });

  it("trust_score stays last-write-wins, deliberately", () => {
    // It is a smoothed score with its own decay, not a count: a lost update
    // shifts one window's cap and the next event corrects it, where a lost
    // COUNT is permanent. Both clamps must survive.
    expect(guard).toMatch(/trust_score: Math\.min\(100, rep\.trust_score \+ p\.trust_reply_gain\)/);
    expect(guard).toMatch(/trust_score: Math\.max\(0, rep\.trust_score - p\.trust_send_decay\)/);
  });
});

describe("the write goes through the atomic function, and degrades honestly", () => {
  const guard = readCode("src/lib/wa-guard.ts");
  const rc = readCode("src/lib/runtime-config.ts");

  it("sbRpc distinguishes 'not migrated' from 'broken'", () => {
    expect(rc).toMatch(/export async function sbRpc\(/);
    expect(rc).toMatch(/rest\/v1\/rpc\/\$\{fn\}/);
    // 404 is a database where schema.sql has not been re-run.
    expect(rc).toMatch(/missing: res\.status === 404/);
    // Never throws into a caller.
    expect(rc).toMatch(/\} catch \{\s*return \{ ok: false, missing: false \};/);
  });

  it("saveReputation calls it, and falls back rather than dropping the count", () => {
    expect(guard).toMatch(/sbRpc\("wa_rep_bump", \{/);
    expect(guard).toMatch(/p_sender: senderKey/);
    expect(guard).toMatch(/p_bumps: bumps/);
    expect(guard).toMatch(/p_set: update/);
    // An un-migrated database keeps the old absolute write - racy, but a
    // write. Silently doing nothing would be strictly worse than the bug.
    const at = guard.indexOf('sbRpc("wa_rep_bump"');
    const after = guard.slice(at, at + 1200);
    expect(after).toMatch(/if \(res\.ok\) return;/);
    expect(after).toMatch(/sbUpdate\(/);
  });

  it("a call with no bumps still takes the plain update path", () => {
    expect(guard).toMatch(/if \(bumps && Object\.keys\(bumps\)\.length\)/);
  });
});

describe("the SQL is atomic, closed and not reachable by the anon key", () => {
  const sql = read("supabase/schema.sql");

  it("increments happen under the row lock, not in the app", () => {
    expect(sql).toMatch(/create or replace function public\.wa_rep_bump\(/);
    expect(sql).toMatch(/sent_total\s*=\s*coalesce\(sent_total, 0\)\s*\+/);
    expect(sql).toMatch(/replies_total\s*=\s*coalesce\(replies_total, 0\)\s*\+/);
  });

  it("the column list is CLOSED - no dynamic identifier from the caller", () => {
    const at = sql.indexOf("create or replace function public.wa_rep_bump(");
    const body = sql.slice(at, sql.indexOf("$$;", at));
    // format('%I', ...) over a caller-supplied key would let anyone who can
    // call this increment any integer column on the table.
    expect(body).not.toMatch(/format\s*\(/);
    expect(body).not.toMatch(/execute\s/i);
  });

  it("an absent key leaves its column alone; an explicit null clears it", () => {
    // `?` is jsonb key-existence. Using `->>` alone would write NULL over every
    // field the caller simply did not mention.
    expect(sql).toMatch(/case when p_set \? 'paused_until'/);
    expect(sql).toMatch(/else paused_until end/);
  });

  it("SECURITY DEFINER over PostgREST is revoked from anon", () => {
    expect(sql).toMatch(/revoke all on function public\.wa_rep_bump\(text, jsonb, jsonb\) from anon;/);
    expect(sql).toMatch(
      /revoke all on function public\.wa_rep_bump\(text, jsonb, jsonb\) from authenticated;/
    );
    expect(sql).toMatch(
      /grant execute on function public\.wa_rep_bump\(text, jsonb, jsonb\) to service_role;/
    );
    // search_path pinned, or a definer function is a privilege-escalation shape.
    expect(sql).toMatch(/security definer set search_path = public/);
  });

  it("the day roll resets rather than accumulating onto yesterday", () => {
    const at = sql.indexOf("create or replace function public.wa_rep_bump(");
    const body = sql.slice(at, sql.indexOf("$$;", at));
    expect(body).toMatch(/new_contacts_date, ''\) is distinct from \(p_set->>'new_contacts_date'\)/);
  });
});
