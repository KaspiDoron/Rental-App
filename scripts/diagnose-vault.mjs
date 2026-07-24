#!/usr/bin/env node
// WheelDeal - Key Vault diagnostic + recovery-path finder.
//
// "All my keys are gone!" is almost always NOT data loss. The vault stores every
// key AES-256-GCM encrypted in Supabase `app_config`, with the encryption key
// derived from SESSION_SECRET. If SESSION_SECRET changes (e.g. a Vercel -> Cloud
// Run migration), every row becomes UNDECRYPTABLE - the rows are still there, the
// app just can't read them, so the admin panel shows "no key / 0 set".
//
// This script tells you EXACTLY which case you are in, WITHOUT ever printing a
// secret value:
//   - how many app_config rows exist,
//   - how many decrypt with the CURRENT SESSION_SECRET,
//   - (optional) how many decrypt with one or more CANDIDATE secrets you pass in
//     (e.g. paste your old Vercel SESSION_SECRET to prove it unlocks them before
//     you set it on Cloud Run).
// It prints only KEY NAMES and OK/FAIL - never the decrypted values.
//
// USAGE
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... SESSION_SECRET=... \
//     node scripts/diagnose-vault.mjs [--try-secret "old-secret-1"] [--try-secret "old-secret-2"]
//
//   - SESSION_SECRET here should be the value your DEPLOYMENT currently runs with
//     (Cloud Run). Omit it to test only candidates.
//   - Repeat --try-secret to test several candidate old secrets at once.
//
// OUTCOME
//   - "current SESSION_SECRET decrypts N/N": nothing is wrong with the vault; if
//     the panel still shows 0, it is a caching/connection issue, not the keys.
//   - "a CANDIDATE decrypts N/N": THAT is your original secret - set it as
//     SESSION_SECRET on Cloud Run and every key returns instantly.
//   - "0 rows / none decrypt under any secret": the rows were deleted OR the
//     original secret is lost; the values must be re-pasted (they are not
//     recoverable without the secret - that is what AES guarantees).

import { createDecipheriv, scryptSync } from "node:crypto";

// ---- args -------------------------------------------------------------------
const candidates = [];
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === "--try-secret" && process.argv[i + 1]) {
    candidates.push(process.argv[i + 1]);
    i++;
  }
}

const URL = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "")
  .trim()
  .replace(/\/$/, "");
const KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
const CURRENT = process.env.SESSION_SECRET || "";

function die(m) {
  console.error(`\n  ✗ ${m}\n`);
  process.exit(1);
}
if (!URL || !KEY) die("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment.");

// ---- decrypt (IDENTICAL to src/lib/runtime-config.ts) -----------------------
function cryptoKey(secret) {
  return scryptSync(secret || "dev-insecure-secret-change-me", "wheeldeal-config-v1", 32);
}
function tryDecrypt(blob, secret) {
  try {
    const [v, ivB, tagB, dataB] = String(blob).split(":");
    if (v !== "v1") return false;
    const d = createDecipheriv("aes-256-gcm", cryptoKey(secret), Buffer.from(ivB, "base64"));
    d.setAuthTag(Buffer.from(tagB, "base64"));
    // Success = no throw. We DO NOT keep or print the plaintext.
    d.update(Buffer.from(dataB, "base64"));
    d.final();
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const res = await fetch(`${URL}/rest/v1/app_config?select=key,value`, {
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
    cache: "no-store",
  });
  if (res.status === 404) die("The app_config table does not exist - run supabase/schema.sql.");
  if (!res.ok) die(`Supabase read failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const rows = await res.json();

  console.log(`\n  WheelDeal Key Vault diagnostic`);
  console.log(`  ------------------------------------------------------------`);
  console.log(`  app_config rows found: ${rows.length}`);
  if (rows.length === 0) {
    console.log(`\n  The vault table is EMPTY - the encrypted rows are gone. Keys must be`);
    console.log(`  re-pasted in Admin -> Keys (no secret can recover deleted rows).\n`);
    return;
  }

  const secrets = [];
  if (CURRENT) secrets.push({ label: "current SESSION_SECRET", secret: CURRENT });
  candidates.forEach((c, i) => secrets.push({ label: `candidate #${i + 1}`, secret: c }));
  if (secrets.length === 0) {
    console.log(`\n  (No SESSION_SECRET and no --try-secret given - only counting rows.)`);
    console.log(`  Key names present:\n   - ${rows.map((r) => r.key).join("\n   - ")}\n`);
    return;
  }

  // Only "v1:" blobs are encrypted values; anything else is plain (rare).
  const encrypted = rows.filter((r) => String(r.value).startsWith("v1:"));
  console.log(`  encrypted (v1) values: ${encrypted.length}\n`);

  let winner = null;
  for (const s of secrets) {
    let ok = 0;
    for (const r of encrypted) if (tryDecrypt(r.value, s.secret)) ok++;
    const verdict = ok === encrypted.length && ok > 0 ? "  <-- UNLOCKS EVERYTHING" : "";
    console.log(`  ${s.label}: decrypts ${ok}/${encrypted.length}${verdict}`);
    if (ok === encrypted.length && ok > 0 && !winner) winner = s;
  }

  console.log(``);
  if (winner && winner.label === "current SESSION_SECRET") {
    console.log(`  ✓ Your CURRENT SESSION_SECRET already decrypts every key. The vault is`);
    console.log(`    healthy - if the panel shows 0, it is a cache/connection blip, not the`);
    console.log(`    keys. Reload Admin -> Keys; the values are intact in Supabase.`);
  } else if (winner) {
    console.log(`  ✓ RECOVERY FOUND: "${winner.label}" decrypts all ${encrypted.length} keys.`);
    console.log(`    Set THAT exact value as SESSION_SECRET on Cloud Run (and redeploy).`);
    console.log(`    Every key returns instantly - no re-pasting, no data loss.`);
  } else {
    console.log(`  ✗ None of the secrets tried decrypt the rows. The values ARE still in`);
    console.log(`    Supabase but are locked under a SESSION_SECRET you have not provided.`);
    console.log(`    Find your ORIGINAL secret (Vercel -> Settings -> Environment Variables,`);
    console.log(`    the SESSION_SECRET value) and re-run with --try-secret "<that value>".`);
    console.log(`    If the original secret is truly lost, the values cannot be decrypted by`);
    console.log(`    anyone and must be re-pasted in Admin -> Keys.`);
  }
  console.log(`\n  Key names in the vault (${rows.length}):\n   - ${rows.map((r) => r.key).join("\n   - ")}\n`);
}

main().catch((e) => die(e instanceof Error ? e.message : String(e)));
