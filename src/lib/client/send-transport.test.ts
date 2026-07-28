import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { fetchJson } from "./fetch-json";

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

afterEach(() => vi.unstubAllGlobals());

// "COULDN'T REACH THE SERVER JUST NOW" - ABOUT A SERVER THAT ANSWERED.
//
// The send path was a bare `fetch` + `await res.json()`. `res.json()` rejects on
// ANY non-JSON body, so three completely different events landed in the one
// catch arm - the one written for being offline:
//
//   1. fetch rejected      - genuinely offline. The message fits.
//   2. res.json() rejected - the server ANSWERED, with an HTML 500 or a
//      gateway 504. The message is a lie and sends the traveller to check
//      their wifi over a fault on our side.
//   3. the request hung    - no timeout anywhere, so the button just span.
//
// The app already had the fix and the send path was not using it:
// `lib/client/fetch-json` always settles, never throws, and keeps the three
// apart. This pins that the send paths use it - the second helper written for
// this job was deleted rather than kept alongside.

describe("the existing transport already keeps the three apart", () => {
  it("an HTML 500 is an HTTP error, not an offline error", async () => {
    vi.stubGlobal("fetch", async () => new Response("<html>500</html>", { status: 500 }));
    const r = await fetchJson("/api/outreach", { method: "POST" });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(500);
    expect(r.timedOut).toBeUndefined();
    expect(r.error).toMatch(/server had a problem/i);
    expect(r.error).not.toMatch(/Network error/);
  });

  it("our route's JSON failure body becomes the banner copy", async () => {
    // Which is exactly why jsonRoute puts the technical reason in `detail`.
    vi.stubGlobal("fetch", async () =>
      new Response(
        JSON.stringify({
          ok: false,
          code: "server-error",
          error: "Something broke on our side, not yours - nothing was lost. Try again in a moment.",
          detail: "Sending your message: supabase exploded",
          transient: true,
        }),
        { status: 500, headers: { "content-type": "application/json" } }
      )
    );
    const r = await fetchJson<{ code: string }>("/api/outreach", { method: "POST" });
    expect(r.error).toMatch(/broke on our side/);
    expect(r.error).not.toMatch(/supabase/);
    // ...and the machine-readable code still reaches the caller.
    expect(r.data?.code).toBe("server-error");
  });

  it("a hung request settles instead of spinning forever", async () => {
    vi.stubGlobal("fetch", (_u: string, init?: RequestInit) =>
      new Promise<Response>((_res, rej) => {
        init?.signal?.addEventListener("abort", () => rej(new Error("aborted")));
      })
    );
    const r = await fetchJson("/api/outreach", { method: "POST", timeoutMs: 20 });
    expect(r.timedOut).toBe(true);
  });

  it("a non-2xx with a real body keeps the body", async () => {
    // Several send outcomes answer 400 with a body the card renders
    // ("connect your WhatsApp"). Discarding it on status would lose the
    // instruction and leave a mystery error.
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ connect: true, error: "link WhatsApp first" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      })
    );
    const r = await fetchJson<{ connect: boolean }>("/api/outreach", { method: "POST" });
    expect(r.data?.connect).toBe(true);
  });
});

describe("the send paths use it, and there is only one of it", () => {
  it("no second transport helper was left behind", () => {
    // A parallel `postJson` was written for this and deleted: two helpers doing
    // the same job is how the next call site picks the wrong one.
    expect(() => readCode("src/lib/client/post-json.ts")).toThrow();
  });

  it("the shop card's RFQ send no longer hand-rolls fetch + res.json", () => {
    const v = readCode("src/components/VendorCard.tsx");
    expect(v).toMatch(/await fetchJson<OutreachReply>\("\/api\/outreach"/);
    expect(v).not.toMatch(/const d = await res\.json\(\)/);
    // A missing body is its own branch, and it does not claim WhatsApp is
    // unlinked - a transport failure has never been evidence of that.
    expect(v).toMatch(/if \(!d\) \{/);
    expect(v).toMatch(/r\.timedOut/);
  });

  it("and neither does the page's custom-message path", () => {
    const p = readCode("src/app/page.tsx");
    const fn = p.slice(p.indexOf("const customMessage ="), p.indexOf("const customMessage =") + 1600);
    expect(fn).toMatch(/await fetchJson<OutreachReply>\("\/api\/outreach"/);
    expect(fn).not.toMatch(/res\.json\(\)/);
  });

  it("'Push harder' judges success on fields the route actually returns", () => {
    // It tested `r?.ok !== false` against an untyped `res.json()`, which is
    // `undefined !== false` - permanently true. Every push reported success,
    // including the refused, queued and failed ones.
    const p = readCode("src/app/page.tsx");
    expect(p).toMatch(
      /const accepted = Boolean\(r\?\.sent \|\| r\?\.queued \|\| r\?\.duplicate \|\| r\?\.halted\)/
    );
    expect(p).not.toMatch(/r\?\.ok !== false/);
  });

  it("one declared reply shape, and it has no `ok` to be fooled by", () => {
    const t = readCode("src/lib/types.ts");
    const i = t.indexOf("export interface OutreachReply");
    expect(i).toBeGreaterThan(-1);
    const shape = t.slice(i, t.indexOf("}", i));
    expect(shape).toMatch(/sent\?: boolean;/);
    expect(shape).toMatch(/queued\?: boolean;/);
    expect(shape).not.toMatch(/^\s*ok\??:/m);
    // ...and the component no longer casts its way back out of the prop type.
    expect(readCode("src/components/VendorCard.tsx")).not.toMatch(
      /await onCustomMessage\([^)]*\)\) as \{/
    );
  });
});
