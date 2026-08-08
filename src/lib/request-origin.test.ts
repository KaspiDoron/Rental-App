import { describe, it, expect, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { routableOrigin, requestOrigin, publicRequestOrigin } from "./request-origin";

vi.mock("server-only", () => ({}));

// I-1: EVERY DISPATCHER SELF-KICK WAS ADDRESSED TO 0.0.0.0.
//
// The reply lane is driven by an HTTP call the app makes to itself. Six routes
// built that URL from `new URL(req.url).origin`, which on Cloud Run is the BIND
// address - Dockerfile sets HOSTNAME=0.0.0.0 and PORT=8080, and the Next
// standalone server derives req.url from it rather than from the proxy's Host
// header. `kickDispatcher` swallows the resulting failure by design, so the
// dispatcher was never started and nothing was logged: shops replied, agents
// composed answers, and the answers sat in the outbox.
//
// This file pins the invariant repo-wide, because the defect's whole character
// is that it spreads by copy-paste and fails silently.

const REPO = process.cwd();

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith(".ts") || full.endsWith(".tsx")) out.push(full);
  }
  return out;
}

const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

describe("no route builds a self-directed URL from req.url", () => {
  const routeFiles = walk(join(REPO, "src/app/api")).filter((f) => !f.endsWith(".test.ts"));

  it("finds the API routes at all (guards against a silent empty sweep)", () => {
    expect(routeFiles.length).toBeGreaterThan(20);
  });

  // The exact shapes that shipped the bug: an origin taken off the request and
  // then interpolated into a URL string.
  it.each(routeFiles.map((f) => [f.slice(REPO.length + 1), f] as const))(
    "%s",
    (_rel, full) => {
      const code = stripComments(readFileSync(full, "utf8"));
      expect(code).not.toMatch(/\$\{\s*new URL\(req\.url\)\.origin\s*\}/);
      expect(code).not.toMatch(/\$\{\s*url\.origin\s*\}/);
      // `const origin = new URL(req.url).origin` - the indirection that let the
      // bug survive a grep for the interpolated form.
      expect(code).not.toMatch(
        /\b(?:const|let|var)\s+origin\s*=\s*new URL\(req\.url\)\.origin/
      );
      // `{ origin: url.origin }` - how the P0 site actually shipped it. The
      // origin was passed into the ingest as an argument and interpolated
      // there, so none of the patterns above would have caught the one line
      // that broke the reply lane.
      expect(code).not.toMatch(
        /\borigin\s*:\s*(?:url\.origin|new URL\(req\.url\)\.origin)/
      );
    }
  );
});

describe("routableOrigin rejects everything a self-kick could not reach", () => {
  it.each([
    "http://0.0.0.0:8080",
    "https://0.0.0.0",
    "http://localhost:3000",
    "http://127.0.0.1:8080",
    "http://[::1]",
    "http://169.254.169.254",
    "https://wd-web.local",
    "https://worker.internal",
    // Dotless container hostnames - the shape Cloud Run and Docker both produce.
    "https://wd-web",
  ])("%s -> null", (input) => {
    expect(routableOrigin(input)).toBeNull();
  });

  it.each([
    ["https://wheeldeal.pro", "https://wheeldeal.pro"],
    ["wheeldeal.pro", "https://wheeldeal.pro"],
    ["https://wd-web-abc123-uc.a.run.app", "https://wd-web-abc123-uc.a.run.app"],
  ])("%s -> %s", (input, expected) => {
    expect(routableOrigin(input)).toBe(expected);
  });

  it("returns null rather than throwing on junk", () => {
    expect(routableOrigin("")).toBeNull();
    expect(routableOrigin(null)).toBeNull();
    expect(routableOrigin("http://")).toBeNull();
  });
});

describe("requestOrigin prefers the forwarded identity over the bind address", () => {
  const reqWith = (headers: Record<string, string>, url = "http://0.0.0.0:8080/api/wa/tick") =>
    new Request(url, { headers });

  it("REPRODUCTION: with no forwarded headers it yields the unroutable bind origin", () => {
    // This is exactly what every self-kick used to send its fetch to.
    expect(requestOrigin(reqWith({}))).toBe("http://0.0.0.0:8080");
    expect(publicRequestOrigin(reqWith({}))).toBeNull();
  });

  it("uses x-forwarded-host + proto when the proxy sets them", () => {
    const req = reqWith({
      "x-forwarded-host": "wheeldeal.pro",
      "x-forwarded-proto": "https",
    });
    expect(requestOrigin(req)).toBe("https://wheeldeal.pro");
    expect(publicRequestOrigin(req)).toBe("https://wheeldeal.pro");
  });

  it("takes the FIRST value when a proxy chain appends", () => {
    const req = reqWith({
      "x-forwarded-host": "wheeldeal.pro, internal-lb",
      "x-forwarded-proto": "https, http",
    });
    expect(requestOrigin(req)).toBe("https://wheeldeal.pro");
  });

  it("defaults the scheme to https when only the host is forwarded", () => {
    expect(requestOrigin(reqWith({ "x-forwarded-host": "wheeldeal.pro" }))).toBe(
      "https://wheeldeal.pro"
    );
  });

  it("a forwarded host that is itself unroutable still fails the public check", () => {
    const req = reqWith({ "x-forwarded-host": "localhost:3000" });
    expect(publicRequestOrigin(req)).toBeNull();
  });
});
