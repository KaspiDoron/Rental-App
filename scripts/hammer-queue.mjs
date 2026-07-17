#!/usr/bin/env node
// Dev-only concurrency harness (NOT wired into CI): fires parallel storms at
// a local dev server to observe claim serialization and delete-vs-drain
// behavior with real HTTP concurrency.
//
// Usage:
//   1. npm run dev  (with .env.local: ENABLE_DEV_LOGIN=1, OWNER_EMAIL set)
//   2. node scripts/hammer-queue.mjs [baseUrl]
//
// What it does:
//   - logs in via the dev endpoint (owner persona)
//   - fires 10 parallel /api/activity requests (each triggers a drain)
//   - fires a /api/queue delete racing the drains
//   - reports how many sends the drains claim vs. what the claims table
//     should allow (expected: at most 1 per min-gap window per sender)
//
// Read the numbers, don't trust green: this script OBSERVES, it does not
// assert - serverless concurrency is probabilistic.

const base = process.argv[2] ?? "http://localhost:3000";

async function main() {
  const login = await fetch(`${base}/api/auth/dev`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ persona: "owner" }),
  });
  if (!login.ok) {
    console.error("dev login failed - is the dev server running with ENABLE_DEV_LOGIN=1?");
    process.exit(1);
  }
  const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
  const authed = (path, init = {}) =>
    fetch(`${base}${path}`, { ...init, headers: { ...(init.headers ?? {}), cookie } });

  console.log("[1] queue before:");
  const before = await (await authed("/api/queue")).json();
  console.log(`    ${before.total ?? before.items?.length ?? 0} queued`);

  console.log("[2] firing 10 parallel /api/activity drains + 1 racing delete...");
  const t0 = Date.now();
  const storms = Array.from({ length: 10 }, () => authed("/api/activity?limit=5"));
  const firstItem = before.items?.[0];
  const del = firstItem
    ? authed("/api/queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "delete",
          id: firstItem.id,
          vendorId: firstItem.vendorId,
          toNumber: firstItem.toNumber,
        }),
      })
    : Promise.resolve(null);
  const [delRes] = await Promise.all([del, ...storms]);
  console.log(`    completed in ${Date.now() - t0}ms`);
  if (delRes) console.log("    delete verdict:", await delRes.json());

  console.log("[3] queue after:");
  const after = await (await authed("/api/queue")).json();
  console.log(`    ${after.total ?? after.items?.length ?? 0} queued`);
  console.log(
    "\nInterpretation: with claims active, concurrent drains may claim rows but at most ONE send per min-gap window per sender goes out; a deleted vendor must never re-appear (tombstoned)."
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
