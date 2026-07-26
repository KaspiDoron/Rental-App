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

/** The `fetchProfilePictureUrl` function body, isolated from the rest of the file. */
function avatarFetcherSource(): string {
  const src = readCode("src/lib/evolution.ts");
  const start = src.indexOf("export async function fetchProfilePictureUrl");
  expect(start, "fetchProfilePictureUrl must exist in evolution.ts").toBeGreaterThan(-1);
  // Top-level function bodies close with a `}` in column 0.
  const end = src.indexOf("\n}\n", start);
  return src.slice(start, end === -1 ? undefined : end);
}

const WRITE_CALL = /\bsb(Insert|Update|Upsert|Delete|Rpc)\s*\(/;

describe("ephemeral shop avatars: nothing is ever persisted", () => {
  it("the avatar route reads (sbSelect) and never writes", () => {
    const code = readCode(ROUTE);
    expect(code).toMatch(/sbSelect\s*(<[^>]*>)?\s*\(/);
    expect(code).not.toMatch(WRITE_CALL);
  });

  it("fetchProfilePictureUrl performs no Supabase call at all - in-memory only", () => {
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
    expect(read("src/lib/evolution.ts")).toContain('/^https:\\/\\//i.test(raw)');
  });
});
