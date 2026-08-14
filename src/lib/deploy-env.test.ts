import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const wf = readFileSync(join(process.cwd(), ".github/workflows/deploy-gcp.yml"), "utf8");

// A SECRET THE DEPLOY LOOP READS BUT THE STEP NEVER EXPORTS IS A SILENT NO-OP.
//
// The deploy step builds Cloud Run's env from two lists that must agree:
//
//   env:                      <- GitHub injects `${{ secrets.X }}` here
//     REDIS_URL: ...
//   run: for OPTIONAL in ... REDIS_URL ...; do VALUE="${!OPTIONAL:-}" ...
//
// `${!OPTIONAL}` is an indirect expansion of a SHELL variable, so a name in
// the loop that is missing from `env:` expands to "" and is quietly skipped.
// That is exactly what happened to REDIS_URL: it was added to the loop and not
// to the block, so creating the repo secret would have changed nothing while
// looking like it had - the daily caps would have stayed per-instance (up to
// 20x with --max-instances 20) behind an owner's belief that they were atomic.
//
// A wrong number is recoverable. A safety control that reports itself as ON
// while being OFF is the failure this whole codebase's fail-dark discipline
// exists to prevent, so the two lists are now checked against each other.

/** The step's `env:` keys - every name GitHub actually exports to the shell. */
function exportedEnvKeys(): Set<string> {
  // Anchor on the STEP, not on the first textual mention of the command - the
  // phrase "gcloud run deploy" also appears in a comment at the top of the
  // file, and anchoring there silently searched the wrong region.
  const stepStart = wf.indexOf("      - name: Deploy to Cloud Run\n");
  expect(stepStart).toBeGreaterThan(0);
  const envStart = wf.indexOf("\n        env:\n", stepStart);
  expect(envStart).toBeGreaterThan(stepStart);
  // The env block ends at the step's `run:` (the loops live in there).
  const block = wf.slice(envStart, wf.indexOf("\n        run:", envStart));
  const keys = new Set<string>();
  for (const m of block.matchAll(/^\s{10}([A-Z_][A-Z0-9_]*):\s*\$\{\{/gm)) keys.add(m[1]);
  return keys;
}

/** The names the `for OPTIONAL in ...` loop tries to read. */
function optionalLoopNames(): string[] {
  const m = wf.match(/for OPTIONAL in ([^;]+); do/);
  expect(m).toBeTruthy();
  return m![1].trim().split(/\s+/);
}

/** The names the REQUIRED-secret preflight loop checks. */
function requiredLoopNames(): string[] {
  const m = wf.match(/for REQUIRED in ([^;]+); do/);
  expect(m).toBeTruthy();
  return m![1].trim().split(/\s+/);
}

describe("the deploy step can actually deliver every secret it claims to", () => {
  it("every OPTIONAL name is exported in the step's env block", () => {
    const exported = exportedEnvKeys();
    const missing = optionalLoopNames().filter((n) => !exported.has(n));
    expect(
      missing,
      `these names are read by the optional loop but never exported, so they can NEVER reach Cloud Run: ${missing.join(", ")}`
    ).toEqual([]);
  });

  it("every REQUIRED name is exported too - the preflight must be able to see them", () => {
    const exported = exportedEnvKeys();
    const missing = requiredLoopNames().filter((n) => !exported.has(n));
    expect(
      missing,
      `the required-secret preflight reads these but they are not exported, so it would refuse every deploy: ${missing.join(", ")}`
    ).toEqual([]);
  });

  it("REDIS_URL specifically is deliverable - the defect this test was written for", () => {
    expect(optionalLoopNames()).toContain("REDIS_URL");
    expect(exportedEnvKeys()).toContain("REDIS_URL");
  });
});

describe("a transient font fetch cannot fail the pipeline", () => {
  // next/font downloads ~104 files from Google at BUILD time, in BOTH the
  // verify job and again inside `docker build`. It retries each file 3 times
  // and then throws a null-property TypeError that reads like a code bug.
  // Neither build may die on one blip.
  it("the verify build retries rather than failing on the first attempt", () => {
    const verifyBuild = wf.slice(wf.indexOf("- name: Build\n"), wf.indexOf("- name: Cache Playwright"));
    expect(verifyBuild).toMatch(/for ATTEMPT in 1 2 3/);
    expect(verifyBuild).toMatch(/npm run build/);
    // ...and still fails loudly when it is NOT transient.
    expect(verifyBuild).toMatch(/exit 1/);
  });

  it("the image build retries too - the deploy path fetches the same fonts", () => {
    const imageBuild = wf.slice(wf.indexOf("- name: Build image"), wf.indexOf("- name: Push image"));
    expect(imageBuild).toMatch(/for ATTEMPT in 1 2 3/);
    expect(imageBuild).toMatch(/docker build/);
    expect(imageBuild).toMatch(/exit 1/);
  });

  it("the Next build cache is restored, so most runs make no font requests at all", () => {
    expect(wf).toMatch(/path: \$\{\{ github\.workspace \}\}\/\.next\/cache/);
    expect(wf).toMatch(/restore-keys:/);
  });
});
