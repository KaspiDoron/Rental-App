import { describe, it, expect, beforeEach } from "vitest";
import {
  nationalTail,
  numberFilter,
  identityKey,
  sameNumber,
  threadNumberOr,
  waIdKind,
  isPhoneJid,
  lidKey,
} from "./phone-key";
import { phoneFromPayload, rememberAlias, aliasFromMemory, resetAliases } from "./lid-alias";

// The live failure this whole capability exists for. One shop, three spellings:
//   - Google Places exposed the NATIONAL number, and that is what we stored
//   - WhatsApp delivered the INTERNATIONAL one on the reply
//   - the multi-device JID added a ":12" device suffix on top
// Every layer routed on a phone key and each layer picked a different one, so
// the reply "The regular price is 700 per day I'll give you 500 per day" was
// stored against a number no read query matched.
const NATIONAL = "09661952196";
const INTERNATIONAL = "639661952196";
const DEVICE_JID = "639661952196:12@s.whatsapp.net";

describe("one shop is one identity, however it was spelled", () => {
  it("every spelling collapses to the same tail", () => {
    expect(nationalTail(NATIONAL)).toBe(nationalTail(INTERNATIONAL));
    expect(nationalTail(DEVICE_JID)).toBe(nationalTail(NATIONAL));
    expect(nationalTail("+63 966 195 2196")).toBe(nationalTail(INTERNATIONAL));
  });

  it("a different shop does NOT collapse to the same tail", () => {
    expect(nationalTail("639166569405")).not.toBe(nationalTail(INTERNATIONAL));
  });

  it("a number too short to name a line has no tail (never a wildcard match)", () => {
    expect(nationalTail("12345")).toBe("");
    expect(nationalTail("")).toBe("");
  });

  it("matching is SYMMETRIC - the direction that used to fail now holds", () => {
    // international -> national already worked via numberVariants.
    expect(sameNumber(INTERNATIONAL, NATIONAL)).toBe(true);
    // national -> international is the one that silently failed: with no
    // country code in hand there was nothing to expand to.
    expect(sameNumber(NATIONAL, INTERNATIONAL)).toBe(true);
    expect(sameNumber(NATIONAL, "639166569405")).toBe(false);
  });
});

describe("numberFilter - the database-side boundary primitive", () => {
  it("matches the national spelling from the international one and back", () => {
    const fromIntl = numberFilter("to_number", INTERNATIONAL);
    expect(fromIntl).toContain("to_number.eq.639661952196");
    expect(fromIntl).toContain("to_number.eq.09661952196");

    // The direction an exact `=eq.` could never do: only a tail is available.
    const fromNat = numberFilter("to_number", NATIONAL);
    expect(fromNat).toContain(`to_number.like.*${nationalTail(NATIONAL)}`);
  });

  it("is a ready-to-append fragment, so a call site cannot forget the &", () => {
    expect(numberFilter("from_number", INTERNATIONAL).startsWith("&")).toBe(true);
  });

  it("never widens to 'every row' when there is nothing to match", () => {
    // A sentinel row ("session"/"cancel") and junk both keep an exact match:
    // silently dropping the predicate would cross thread boundaries.
    expect(numberFilter("to_number", "session")).toBe("&to_number=eq.session");
    expect(numberFilter("to_number", "")).toBe("&to_number=eq.");
  });

  it("only ever emits digits into the or() grammar", () => {
    const or = threadNumberOr("to_number", "+63 (966) 195-2196") ?? "";
    expect(or).toMatch(/^\([\w.,*]+\)$/);
    expect(or).not.toMatch(/[()]/g.source === "" ? /x/ : /[+\- ]/);
  });
});

describe("identityKey - the same boundary for in-memory joins", () => {
  it("joins an inbound row to the outbound row of the same shop", () => {
    // /api/replies keys a Map on inbound `from_number` and looks it up with the
    // outbound `to_number`. Raw strings never met, so the shop's option menu
    // and its "where are you staying?" never reached the card.
    const bodies = new Map<string, string[]>();
    bodies.set(identityKey(INTERNATIONAL), ["some models 200 and some new 250/day"]);
    expect(bodies.get(identityKey(NATIONAL))).toHaveLength(1);
    expect(bodies.get(identityKey(DEVICE_JID))).toHaveLength(1);
  });

  it("keeps two different shops apart", () => {
    expect(identityKey(INTERNATIONAL)).not.toBe(identityKey("639166569405"));
  });

  it("still produces a key for a number too short to have a tail", () => {
    expect(identityKey("12345")).toBe("12345");
  });
});

describe("JID kinds - a privacy id is not a phone number", () => {
  it("classifies each shape the provider sends", () => {
    expect(waIdKind(DEVICE_JID)).toBe("phone");
    expect(waIdKind("639661952196@c.us")).toBe("phone");
    expect(waIdKind("84912435006@lid")).toBe("lid");
    expect(waIdKind("120363@g.us")).toBe("group");
    expect(waIdKind("status@broadcast")).toBe("group");
    expect(waIdKind("")).toBe("unknown");
  });

  it("a bare stored key is a phone key, a lid JID never is", () => {
    expect(isPhoneJid(INTERNATIONAL)).toBe(true);
    expect(isPhoneJid("84912435006@lid")).toBe(false);
    expect(lidKey("84912435006@lid")).toBe("84912435006");
    expect(lidKey(DEVICE_JID)).toBe("");
  });
});

describe("@lid resolves from evidence, or not at all", () => {
  beforeEach(() => resetAliases());

  it("believes the provider's own phone field on the frame", () => {
    const frame = {
      key: { remoteJid: "84912435006@lid", remoteJidAlt: `${INTERNATIONAL}@s.whatsapp.net` },
    };
    expect(phoneFromPayload(frame)).toBe(INTERNATIONAL);
  });

  it("refuses a field that is not a phone JID - a lid is never a phone", () => {
    expect(phoneFromPayload({ key: { remoteJid: "x@lid", senderPn: "84912435006@lid" } })).toBe("");
    expect(phoneFromPayload({ key: { remoteJid: "x@lid", senderPn: "not-a-jid" } })).toBe("");
    expect(phoneFromPayload({})).toBe("");
  });

  it("a learned alias is scoped to ONE inbox", () => {
    rememberAlias("a@example.com", "84912435006", INTERNATIONAL);
    expect(aliasFromMemory("a@example.com", "84912435006")).toBe(INTERNATIONAL);
    // Two users can hold different chats behind the same opaque id.
    expect(aliasFromMemory("b@example.com", "84912435006")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// THE WIRING. A boundary primitive nobody calls is not a boundary. These pin
// the call sites where an exact match silently dropped a real shop's reply.
// ---------------------------------------------------------------------------

import { readFileSync } from "fs";
import { join } from "path";

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

describe("the boundary is enforced where it decides whether a reply exists", () => {
  it("the INGEST GATE matches tolerantly - it decides if a reply is stored at all", () => {
    const drill = readCode("src/lib/drill.ts");
    expect(drill).toMatch(/numberFilter\("to_number"/);
    expect(drill).not.toMatch(/to_number=eq\./);
  });

  it("the ENGAGEMENT HALT reads replies tolerantly - it decides if we answer", () => {
    const guard = readCode("src/lib/wa-guard.ts").replace(/\s+/g, " ");
    expect(guard).toMatch(/numberFilter\("from_number", opts\.toDigits\)/);
    // ...and every send normalises its routing key exactly once, up front.
    expect(guard).toMatch(/waDigits\(rawOpts\.toDigits\)/);
  });

  it("the AVATAR ownership check matches tolerantly - it decides if a photo loads", () => {
    const avatar = readCode("src/app/api/wa/avatar/route.ts");
    expect(avatar).toMatch(/numberFilter\("to_number"/);
    expect(avatar).not.toMatch(/to_number=eq\./);
    // Still zero persistence: an avatar is someone else's photo.
    expect(avatar).not.toMatch(/sbInsert|sbUpdate|sbDelete/);
  });

  it("the TRANSCRIPT joins both directions tolerantly", () => {
    const thread = readCode("src/app/api/thread/route.ts");
    expect(thread).toMatch(/numberFilter\("from_number"/);
    expect(thread).toMatch(/numberFilter\("to_number"/);
  });

  it("the ENGINE reads its own thread tolerantly", () => {
    const loop = readCode("src/lib/agent-loop.ts").replace(/\s+/g, " ");
    expect(loop).toMatch(/numberFilter\( "from_number", from \)/);
    expect(loop).toMatch(/numberFilter\( "to_number", from \)/);
  });

  it("an @lid frame is RESOLVED, never dropped and never guessed", () => {
    const ingest = readCode("src/lib/wa/ingest.ts");
    expect(ingest).toMatch(/resolveChatIdentity/);
    // The old blanket drop of anything that was not a phone JID is gone.
    expect(ingest).not.toMatch(/!remoteJid\.endsWith\("@s\.whatsapp\.net"\)/);
    // Unresolvable => dropped WITH a trace, so it is never silent.
    expect(ingest).toMatch(/unresolved-identity/);
    // The alias is persisted in existing JSONB - no migration.
    expect(ingest).toMatch(/lid: chatLid/);
  });

  it("the guarded destinations RESOLVE to a stored thread instead of trusting the client", () => {
    for (const f of [
      "src/app/api/negotiate/consent/route.ts",
      "src/app/api/negotiate/close-deal/route.ts",
    ]) {
      const code = readCode(f);
      expect(code).toMatch(/resolveKnownThreadNumber/);
      expect(code).toMatch(/digits = stored/);
    }
  });
});
