import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

// ZERO-PERSISTENCE PIN for shop profile pictures.
//
// A shop owner's WhatsApp avatar belongs to them, not to us. The whole feature
// is built so the URL exists only in a short-TTL in-process cache and in React
// state for the length of one search - it must never reach Supabase, Storage,
// or the browser's own durable storage.
//
// That property is structural, not behavioural: there is no unit that can
// "fail" if a future edit adds an INSERT, because the insert would simply
// succeed. So it is pinned at the source level, the same way
// hardening-invariants.test.ts pins the other integration-bound invariants.

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");
// Structural assertions must match CODE, not the comments that deliberately
// name the patterns being forbidden.
const readCode = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

const ROUTE = "src/app/api/wa/avatar/route.ts";
const CLIENT = "src/components/ShopAvatar.tsx";

/** The avatar-fetch region (the cached wrapper + the uncached worker),
 * isolated from the rest of the file. */
function avatarFetcherSource(): string {
  const src = readCode("src/lib/evolution.ts");
  const start = src.indexOf("export async function fetchProfilePicture(");
  expect(start, "fetchProfilePicture must exist in evolution.ts").toBeGreaterThan(-1);
  const end = src.indexOf("export async function fetchProfilePictureUrl(", start);
  return src.slice(start, end === -1 ? undefined : end);
}

const WRITE_CALL = /\bsb(Insert|Update|Upsert|Delete|Rpc)\s*\(/;

describe("ephemeral shop avatars: nothing is ever persisted", () => {
  it("the avatar route reads (sbSelect) and never writes", () => {
    const code = readCode(ROUTE);
    expect(code).toMatch(/sbSelect\s*(<[^>]*>)?\s*\(/);
    expect(code).not.toMatch(WRITE_CALL);
  });

  it("fetchProfilePicture performs no Supabase call at all - in-memory only", () => {
    const fn = avatarFetcherSource();
    expect(fn).not.toMatch(WRITE_CALL);
    expect(fn).not.toMatch(/\bsbSelect\s*\(/);
    // The cache is bounded and expiring, so it cannot become a de facto store.
    expect(fn).toMatch(/boundedSet\(/);
    expect(fn).toMatch(/exp:\s*Date\.now\(\)\s*\+\s*AVATAR_TTL_MS/);
  });

  it("the client cache is memory-only and purgeable - never localStorage", () => {
    const code = readCode(CLIENT);
    expect(code).not.toMatch(/localStorage|sessionStorage|indexedDB/);
    expect(code).toMatch(/export function clearShopAvatars/);
  });

  it("both reset paths purge the client cache, so avatars die with the search", () => {
    const page = readCode("src/app/page.tsx");
    const purges = (page.match(/clearShopAvatars\(\)/g) ?? []).length;
    expect(purges).toBeGreaterThanOrEqual(2);
  });

  it("no schema column exists to persist an avatar into", () => {
    const schema = read("supabase/schema.sql").toLowerCase();
    expect(schema).not.toMatch(/profile_picture|avatar_url|profilepic/);
  });
});

describe("ephemeral shop avatars: you can only see a shop you messaged", () => {
  it("the route proves ownership through THIS user's own outbound history", () => {
    const code = readCode(ROUTE);
    expect(code).toMatch(/direction=eq\.outbound/);
    expect(code).toMatch(/raw->>sender=eq\./);
    // A stranger's number answers exactly like a shop with no picture, so the
    // route cannot be used to probe which numbers exist.
    expect(code).toMatch(/url:\s*null/);
  });

  it("a shop you have only QUEUED is still one of your threads", () => {
    // Requiring a DELIVERED message meant no avatar resolved until the queue
    // drained - at the start of a search that is every shop on the board, which
    // is what "none of the shop images load" actually looked like. A queued row
    // is the user's own action and proves ownership just as well.
    const code = readCode(ROUTE);
    expect(code).toMatch(/wa_outbox/);
    expect(code).toMatch(/sender_key=eq\./);
  });

  it("the response is never shared-cacheable", () => {
    expect(readCode(ROUTE)).toMatch(/private,\s*no-store/);
  });

  it("only an https URL is ever handed to an <img src>", () => {
    // Read raw here: comment-stripping would mangle the regex literal itself.
    // Every candidate field from every Evolution route goes through this one
    // test, so a build that answers with an http:// or data: URL is dropped.
    expect(read("src/lib/evolution.ts")).toContain('/^https:\\/\\//i.test(c)');
  });

  it("the browser is handed OUR proxy path, never WhatsApp's CDN url", () => {
    // A signed pps.whatsapp.net URL can be refused by the CDN, and it is not
    // ours to hand around; the route streams the bytes instead.
    const code = readCode(ROUTE);
    expect(code).toMatch(/img=1&number=/);
    expect(code).toMatch(/startsWith\("image\/"\)/);
  });
});

// ---------------------------------------------------------------------------
// ...AND IT HAS TO ACTUALLY ARRIVE. The lookup was never failing; it was a
// two-phase negotiation - fetch JSON for a URL, then fetch the URL - started
// only after React mounted, answered `no-store`, and repeated on every scroll.
// ---------------------------------------------------------------------------

describe("the avatar is one request, started at render", () => {
  const avatar = () =>
    readFileSync(join(process.cwd(), "src/components/ShopAvatar.tsx"), "utf8");

  it("points straight at the proxy - no JSON hop, no effect, no waiting", () => {
    const src = avatar();
    expect(src).toMatch(/src=\{`\/api\/wa\/avatar\?img=1&number=/);
    expect(src).not.toMatch(/fetch\(/);
    expect(src).not.toMatch(/useEffect/);
  });

  it("the initial is the box itself, so nothing flashes or shifts", () => {
    const src = avatar();
    expect(src).toMatch(/bg-brandblue-soft/);
    expect(src).toMatch(/absolute inset-0/);
  });

  it("a miss is remembered BRIEFLY - never a session-permanent verdict", () => {
    // DELIBERATE REWRITE of the old `missing.add(digits)` pin: the unbounded
    // Set made one bad minute (asked pre-send, a 429 during a mount storm)
    // retire a shop to a grey initial for the whole session. The memory now
    // carries a timestamp and expires.
    const src = avatar();
    expect(src).toMatch(/missing\.set\(digits, Date\.now\(\)\)/);
    expect(src).toMatch(/MISSING_TTL_MS/);
    expect(src).not.toMatch(/missing\.add\(/);
  });

  it("the bytes are privately cacheable, and still never shared", () => {
    const route = readFileSync(join(process.cwd(), "src/app/api/wa/avatar/route.ts"), "utf8");
    expect(route).toMatch(/AVATAR_CACHE = \{ "Cache-Control": "private, max-age=\d+" \}/);
    expect(route).not.toMatch(/"Cache-Control": "public/);
  });
});

// ---------------------------------------------------------------------------
// AN AVATAR FAILURE IS NOT A VERDICT. Qui's card asked before the shop was
// messaged, got a 200 JSON body as its <img> answer, latched `broken` with no
// reset path, and two strikes retired the number to a module-level Set for
// the session - while WhatsApp plainly showed the photo. Each layer now has
// the property the incident proved missing.
// ---------------------------------------------------------------------------

describe("an avatar failure is not a verdict", () => {
  it("image mode NEVER answers a non-image body - every nothing is a 404 + x-avatar verdict", () => {
    const route = readCode(ROUTE);
    expect(route).toMatch(/"x-avatar": "unowned"/);
    expect(route).toMatch(/"x-avatar": "none"/);
    expect(route).toMatch(/"x-avatar": "failed"/);
    // The pre-ownership and bad-number exits are image-shaped in image mode.
    expect(route).toMatch(/if \(wantsImage\) return new NextResponse\(null, \{ status: 404, headers: UNOWNED \}\);/);
  });

  it("the client's ask identity changes with the vendor's state (the natural retry)", () => {
    const client = readCode(CLIENT);
    expect(client).toMatch(/retryKey/);
    // broken latches per askKey, so a stage change un-latches by construction.
    expect(client).toMatch(/brokenKey !== askKey/);
  });

  it("cards pass the vendor stage as the retry token", () => {
    expect(readCode("src/components/VendorCard.tsx")).toMatch(/retryKey=\{vendor\.stage\}/);
    expect(readCode("src/app/page.tsx")).toMatch(/retryKey=\{v\.stage\}/);
  });

  it("pre-contact, the shop's public Places photo fills the box (no blank board)", () => {
    expect(readCode(CLIENT)).toMatch(/photoUrl/);
    expect(readCode("src/components/VendorCard.tsx")).toMatch(/photoUrl=\{vendor\.photoUrl\}/);
  });

  it("the server lookup dedups in-flight, bounds its total time, and never feeds an @lid as a number", () => {
    const fn = avatarFetcherSource();
    expect(fn).toMatch(/avatarInFlight/);
    expect(fn).toMatch(/Date\.now\(\) \+ 4_000/);
    expect(fn).toMatch(/@lid\\b/);
  });

  it("a failure is negatively cached for SECONDS, a real answer for the full TTL", () => {
    const fn = avatarFetcherSource();
    expect(fn).toMatch(/exp: Date\.now\(\) \+ AVATAR_FAIL_TTL_MS/);
    expect(fn).toMatch(/exp: Date\.now\(\) \+ AVATAR_TTL_MS/);
  });
});
