import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

// A STALE BRANCH NAME IN CONFIG IS A LIVE MISCONFIGURATION SOMEWHERE ELSE.
//
// `claude/rental-negotiation-app-pc33ux` was deleted long ago. It survived in
// CLAUDE.md ("Develop on ..."), in the deploy workflow (where a comment called
// it "the live production branch"), and in infra/gcp/README's clone command.
// Nothing broke in CI - the workflow simply never fired for a branch that could
// not receive a push - so it read as harmless.
//
// It was not. Render's Blueprint had been pointed at that branch, so every
// Manual Sync failed with "not found: file: .../render.yaml": a file that is
// present and valid on master, reported missing because the branch under it was
// gone. The Evolution retention cron therefore never got created, and the
// Evolution database was on course to fill in 17-28 days at beta scale.

const DEAD_BRANCH = "claude/rental-negotiation-app-pc33ux";

describe("no config points at a branch that does not exist", () => {
  it("the deploy workflow neither triggers on nor deploys the dead branch", () => {
    const wf = read(".github/workflows/deploy-gcp.yml");
    // The name may appear in the comment explaining its removal - what must be
    // gone is any LIST ENTRY or ref comparison naming it.
    expect(wf).not.toMatch(new RegExp(`^\\s*-\\s*${DEAD_BRANCH}\\s*$`, "m"));
    expect(wf).not.toContain(`refs/heads/${DEAD_BRANCH}`);
    // ...and master still both triggers and deploys.
    expect(wf).toMatch(/^\s*-\s*master\s*$/m);
    expect(wf).toContain("refs/heads/master");
  });

  it("CLAUDE.md names the branch this work actually ships from", () => {
    const md = read("CLAUDE.md");
    const section = md.slice(md.indexOf("## Working branch"));
    expect(section).toContain("claude/rental-agents-legal-setup-o7rgcv");
    // The instruction must not tell a future session to develop on a dead
    // branch - that is how the blueprint got pointed at one.
    expect(section).not.toMatch(new RegExp(`Develop on \`${DEAD_BRANCH}\``));
  });

  it("CLAUDE.md says which branch Render reads, because that is not obvious", () => {
    // The Cloud Run deploy follows a push; the Render Blueprint does not follow
    // anything - it reads one configured branch when a human clicks sync. A
    // render.yaml change on a feature branch is inert, and nothing in the repo
    // said so.
    const section = read("CLAUDE.md").slice(read("CLAUDE.md").indexOf("## Working branch"));
    expect(section).toMatch(/Render/);
    expect(section).toMatch(/Manual Sync/i);
    expect(section).toMatch(/master/);
  });

  it("render.yaml says the same thing, where someone editing it will see it", () => {
    const y = read("render.yaml");
    const header = y.slice(0, y.indexOf("databases:"));
    expect(header).toMatch(/BLUEPRINT MUST TRACK `master`/);
  });

  it("the infra clone command checks out a branch that exists", () => {
    const md = read("infra/gcp/README.md");
    expect(md).not.toContain(`git clone -b ${DEAD_BRANCH}`);
    expect(md).toMatch(/git clone -b master/);
  });

  it("REALITY CHECK: the branches these files name are really on the remote", () => {
    // The point of this whole file. Skips rather than fails where git or the
    // remote is unavailable (a fresh CI checkout, an offline sandbox) - a test
    // that cannot reach the remote must not invent a verdict about it.
    let heads = "";
    try {
      heads = execSync("git ls-remote --heads origin", {
        encoding: "utf8",
        timeout: 20_000,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      return;
    }
    if (!heads.trim()) return;
    expect(heads).toContain("refs/heads/master");
    expect(heads).not.toContain(`refs/heads/${DEAD_BRANCH}`);
    // Every branch the deploy workflow lists must actually exist, except the
    // conventional `main` fallback which is deliberately kept for a future
    // rename.
    const wf = read(".github/workflows/deploy-gcp.yml");
    const listed = [...wf.matchAll(/^\s*-\s*(claude\/[\w./-]+)\s*$/gm)].map((m) => m[1]);
    expect(listed.length).toBeGreaterThan(0);
    for (const b of listed) expect(heads, `workflow lists ${b}`).toContain(`refs/heads/${b}`);
  });

  it("render.yaml really is at the root, with every Dockerfile it names", () => {
    // The other half of the sync error: Render reported the FILE missing. It is
    // not - and if any referenced build context were missing, the sync would
    // fail again for a different reason the moment the branch is fixed.
    expect(existsSync(join(process.cwd(), "render.yaml"))).toBe(true);
    const y = read("render.yaml");
    for (const m of y.matchAll(/dockerfilePath:\s*\.\/(\S+)/g)) {
      expect(existsSync(join(process.cwd(), m[1])), `missing ${m[1]}`).toBe(true);
    }
  });
});
