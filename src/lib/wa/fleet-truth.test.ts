import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("server-only", () => ({}));

let hosts: { url: string; key: string }[] = [];
let hostsThrows = false;

vi.mock("../evolution", () => ({
  getHosts: async () => {
    if (hostsThrows) throw new Error("config unreadable");
    return hosts;
  },
}));

import {
  pickInstanceField,
  parseInstanceRecord,
  findDualSockets,
  looksDeaf,
  fleetTruth,
  type InstanceTruth,
} from "./fleet-truth";

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

const inst = (over: Partial<InstanceTruth> = {}): InstanceTruth => ({
  name: "wd_a",
  state: "open",
  disconnectCode: null,
  disconnectAt: null,
  messages: 10,
  contacts: null,
  chats: null,
  proxied: null,
  ownerJid: null,
  createdAt: null,
  host: "https://h1",
  ...over,
});

beforeEach(() => {
  hosts = [{ url: "https://h1", key: "k" }];
  hostsThrows = false;
  vi.restoreAllMocks();
});

// ONE RESPONSE, SIX ANSWERS, AND WE HAVE BEEN THROWING FIVE OF THEM AWAY.
//
// /instance/fetchInstances is already called three times in evolution.ts and
// every call reads connectionStatus and discards the rest: the numeric
// disconnect reason, the message counts, the settings in force, the proxy
// actually applied, the owner JID. This is field extraction, not new plumbing.

describe("the dialects", () => {
  it("reads the flat shape", () => {
    const t = parseInstanceRecord({ name: "wd_a", connectionStatus: "open" }, "https://h1")!;
    expect(t.name).toBe("wd_a");
    expect(t.state).toBe("open");
  });

  it("reads the nested shape", () => {
    const t = parseInstanceRecord(
      { instance: { instanceName: "wd_a", state: "connecting" } },
      "https://h1"
    )!;
    expect(t.name).toBe("wd_a");
    expect(t.state).toBe("connecting");
  });

  it("ONE SPELLING FOR OPEN - Evolution says connected, this repo says open", () => {
    // A tile saying "connected" beside a badge saying "open" is two states on
    // one screen, which this codebase has shipped before.
    expect(parseInstanceRecord({ name: "a", connectionStatus: "connected" }, "h")!.state).toBe("open");
    expect(parseInstanceRecord({ name: "a", state: "CONNECTED" }, "h")!.state).toBe("open");
  });

  it("a record with no resolvable name is dropped, not guessed at", () => {
    expect(parseInstanceRecord({ connectionStatus: "open" }, "h")).toBeNull();
    expect(parseInstanceRecord(null, "h")).toBeNull();
    expect(parseInstanceRecord("nope", "h")).toBeNull();
  });

  it("pickInstanceField looks in both the record and its inner instance", () => {
    expect(pickInstanceField({ a: 1 }, "a")).toBe(1);
    expect(pickInstanceField({ instance: { a: 2 } }, "a")).toBe(2);
    expect(pickInstanceField({ a: null, instance: { a: 3 } }, "a")).toBe(3);
    expect(pickInstanceField({}, "a")).toBeUndefined();
  });
});

describe("THE FIVE FIELDS WE HAVE BEEN DISCARDING", () => {
  const raw = {
    name: "wd_a",
    connectionStatus: "close",
    disconnectionReasonCode: 401,
    disconnectionAt: "2026-08-09T10:00:00.000Z",
    _count: { Message: 42, Contact: 7, Chat: 3 },
    Proxy: { host: "p" },
    ownerJid: "66812345678@s.whatsapp.net",
    createdAt: "2026-08-01T00:00:00.000Z",
  };

  it("extracts the NUMERIC disconnect reason", () => {
    // Part 0.37: the old detector regex-matched statusReason against the WORD
    // "logged out" while Evolution sends the NUMBER 401.
    expect(parseInstanceRecord(raw, "h")!.disconnectCode).toBe(401);
  });

  it("extracts the counts the deaf-session check needs", () => {
    const t = parseInstanceRecord(raw, "h")!;
    expect(t.messages).toBe(42);
    expect(t.contacts).toBe(7);
    expect(t.chats).toBe(3);
  });

  it("A MISSING PROXY FIELD IS null, NOT false", () => {
    // "The host did not report it" and "no proxy is attached" are different
    // facts. Rendering them the same way reports unverified egress as
    // verified-absent, which is the strongest version of the fail-green bug.
    expect(parseInstanceRecord({ name: "a" }, "h")!.proxied).toBeNull();
    expect(parseInstanceRecord({ name: "a", Proxy: { host: "p" } }, "h")!.proxied).toBe(true);
    expect(parseInstanceRecord({ name: "a", Proxy: null }, "h")!.proxied).toBeNull();
  });

  it("missing counts stay null rather than becoming zero", () => {
    const t = parseInstanceRecord({ name: "a", connectionStatus: "open" }, "h")!;
    expect(t.messages).toBeNull();
    expect(t.disconnectCode).toBeNull();
  });
});

describe("DUAL SOCKETS - the condition nothing could observe", () => {
  it("one instance reporting open on two hosts is flagged", () => {
    // WhatsApp answers this with connectionReplaced. render.yaml currently
    // advises adding hosts, which would multiply it.
    const found = findDualSockets([
      inst({ name: "wd_a", host: "https://h1" }),
      inst({ name: "wd_a", host: "https://h2" }),
      inst({ name: "wd_b", host: "https://h1" }),
    ]);
    expect(found).toEqual(["wd_a"]);
  });

  it("only OPEN counts - a closed leftover on a second host is not a dual socket", () => {
    expect(
      findDualSockets([
        inst({ name: "wd_a", host: "https://h1", state: "open" }),
        inst({ name: "wd_a", host: "https://h2", state: "close" }),
      ])
    ).toEqual([]);
  });

  it("the same host listing an instance twice is not a dual socket", () => {
    expect(
      findDualSockets([inst({ name: "wd_a" }), inst({ name: "wd_a" })])
    ).toEqual([]);
  });
});

describe("the app-layer deaf check", () => {
  it("open, sending, and the message count has not moved", () => {
    // C4's literal remedy needs the Baileys socket, which lives in the Evolution
    // container. This is the observable half of the same condition.
    expect(looksDeaf({ state: "open", messages: 10 }, { state: "open", messages: 10 }, 5)).toBe(true);
  });

  it("a moving count is not deaf", () => {
    expect(looksDeaf({ state: "open", messages: 10 }, { state: "open", messages: 12 }, 5)).toBe(false);
  });

  it("NO OUTBOUND MEANS NO VERDICT - an idle account is not a deaf one", () => {
    expect(looksDeaf({ state: "open", messages: 10 }, { state: "open", messages: 10 }, 0)).toBe(false);
  });

  it("an UNKNOWN count is unknown, never flat", () => {
    // A build that does not send _count would otherwise report its entire fleet
    // as deaf.
    expect(looksDeaf({ state: "open", messages: null }, { state: "open", messages: 10 }, 5)).toBe(false);
    expect(looksDeaf({ state: "open", messages: 10 }, { state: "open", messages: null }, 5)).toBe(false);
  });

  it("a closed session is not deaf, it is closed", () => {
    expect(looksDeaf({ state: "close", messages: 1 }, { state: "open", messages: 1 }, 5)).toBe(false);
  });
});

describe("A FAILED HOST RETURNS null, NEVER AN EMPTY FLEET", () => {
  it("no hosts configured reads as unreadable, not as a healthy empty fleet", async () => {
    hosts = [];
    expect(await fleetTruth()).toBeNull();
  });

  it("an unreadable host list reads as unreadable", async () => {
    hostsThrows = true;
    expect(await fleetTruth()).toBeNull();
  });

  it("every host dark returns null rather than zero instances", async () => {
    // This is the fail-dark contract in one line. An empty array reads as "the
    // fleet is fine and empty" - the exact lie the Command Center shipped nine
    // times over.
    hosts = [
      { url: "https://h1", key: "k" },
      { url: "https://h2", key: "k" },
    ];
    vi.stubGlobal("fetch", async () => {
      throw new Error("ECONNREFUSED");
    });
    expect(await fleetTruth()).toBeNull();
  });

  it("a partially dark fleet reports the instances AND the dark hosts", async () => {
    // A fleet of 200 reading "12 open" while three hosts are unreachable is a
    // more dangerous number than no number at all, so the darkness travels with
    // the count instead of being folded into it.
    hosts = [
      { url: "https://h1", key: "k" },
      { url: "https://h2", key: "k" },
    ];
    vi.stubGlobal("fetch", async (url: string) => {
      if (String(url).startsWith("https://h1")) {
        return {
          ok: true,
          json: async () => [{ name: "wd_a", connectionStatus: "open" }],
        } as unknown as Response;
      }
      return { ok: false, status: 502 } as unknown as Response;
    });
    const t = (await fleetTruth())!;
    expect(t.instances.map((i) => i.name)).toEqual(["wd_a"]);
    expect(t.hostsOk).toEqual(["https://h1"]);
    expect(t.hostsDark).toEqual([{ host: "https://h2", reason: "HTTP 502" }]);
  });

  it("asks for the WHOLE list - the instanceName filter is what discards the fleet", async () => {
    let seen = "";
    vi.stubGlobal("fetch", async (url: string) => {
      seen = String(url);
      return { ok: true, json: async () => [] } as unknown as Response;
    });
    await fleetTruth();
    expect(seen).toMatch(/\/instance\/fetchInstances$/);
    expect(seen).not.toMatch(/instanceName=/);
  });
});

describe("it reuses the host list rather than parsing its own", () => {
  it("imports getHosts from evolution", () => {
    const code = readCode("src/lib/wa/fleet-truth.ts");
    expect(code).toMatch(/import \{ getHosts, type Host \} from "\.\.\/evolution"/);
    // A second host parser would be a second source of truth about which hosts
    // exist - precisely the drift the dual-socket detector exists to catch.
    expect(code).not.toMatch(/EVOLUTION_HOSTS/);
  });
});
