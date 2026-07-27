import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// THE CHOKEPOINT CONTRACT.
//
// Every WhatsApp image byte in the system passes through evolution's
// fetchMediaBase64 - the vision worker, wa/ingest, wa-sync and the media proxy
// all call it. If the orientation is not measured THERE it is not measured
// anywhere, and four consumers each guess differently about the same sideways
// price board. So this suite drives the real function against a stubbed
// Evolution host and asserts the declaration arrives with the bytes, that the
// bytes themselves are unchanged, and that a hostile image still yields a reply.

vi.mock("server-only", () => ({}));
vi.mock("../runtime-config", () => ({
  getConfig: async (k: string) =>
    k === "EVOLUTION_API_URL" ? "https://evo.test" : k === "EVOLUTION_API_KEY" ? "k" : null,
  sbInsert: async () => true,
  sbSelect: async () => [],
  sbSelectStrict: async () => [],
  sbDelete: async () => true,
}));

import { fetchMediaBase64 } from "../evolution";
import { readOrientation } from "./orientation";

// ---------------------------------------------------------------------------
// The same hand-built EXIF fixtures the parser suite uses, kept local so this
// file states its own inputs.
// ---------------------------------------------------------------------------
const ASCII = (s: string) => Array.from(s, (c) => c.charCodeAt(0));

function concat(...parts: (Uint8Array | number[])[]): Uint8Array {
  const arrays = parts.map((p) => (p instanceof Uint8Array ? p : Uint8Array.from(p)));
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
  let at = 0;
  for (const a of arrays) {
    out.set(a, at);
    at += a.length;
  }
  return out;
}

/** Little-endian TIFF, one IFD0 entry: Orientation = value. */
function tiff(value: number): Uint8Array {
  const b = new Uint8Array(26);
  b.set(ASCII("II"), 0);
  b[2] = 42;
  b[4] = 8;
  b[8] = 1; // one entry
  b[10] = 0x12;
  b[11] = 0x01; // tag 0x0112, little-endian
  b[12] = 3; // SHORT
  b[14] = 1; // count
  b[18] = value;
  return b;
}

function exifJpeg(value: number, padBytes = 0): Uint8Array {
  const payload = concat(ASCII("Exif"), [0, 0], tiff(value));
  const len = payload.length + 2;
  const pad = Uint8Array.from(new Array(padBytes), (_, i) => (i * 13) % 251);
  return concat(
    [0xff, 0xd8, 0xff, 0xe1, (len >> 8) & 0xff, len & 0xff],
    payload,
    pad,
    [0xff, 0xd9]
  );
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

/** Stand in for the Evolution host: one JSON reply, whatever we are told to say. */
function stubEvolution(payload: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    )
  );
}

beforeEach(() => {
  vi.unstubAllGlobals();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchMediaBase64 declares orientation for every image it hands on", () => {
  it("measures the EXIF tag of a sideways price board", async () => {
    // 400 bytes of trailing scan data - the tag is in the header, as always.
    const bytes = exifJpeg(6, 400);
    stubEvolution({ base64: b64(bytes), mimetype: "image/jpeg" });

    const media = await fetchMediaBase64("traveller@example.com", { key: { id: "abc" } });
    expect(media).not.toBeNull();
    expect(media!.orientation?.orientation).toBe(6);
    expect(media!.orientation?.rotateDeg).toBe(90);
    expect(media!.orientation?.swapsAxes).toBe(true);
    expect(media!.orientation?.source).toBe("exif-jpeg");
  });

  it("returns the bytes UNCHANGED - this layer describes, it never rewrites", async () => {
    const bytes = exifJpeg(6, 400);
    stubEvolution({ base64: b64(bytes), mimetype: "image/jpeg" });

    const media = await fetchMediaBase64("traveller@example.com", { key: { id: "abc" } });
    expect(media!.base64).toBe(b64(bytes));
    // Re-parsing what we hand on must give the same answer we declared, which is
    // what makes the declaration checkable by any downstream consumer.
    expect(readOrientation(Buffer.from(media!.base64, "base64"))).toEqual(media!.orientation);
  });

  it("strips a data-URL prefix before declaring, exactly as before", async () => {
    const bytes = exifJpeg(8, 300);
    stubEvolution({ base64: `data:image/jpeg;base64,${b64(bytes)}`, mimetype: "image/jpeg" });

    const media = await fetchMediaBase64("traveller@example.com", { key: { id: "abc" } });
    expect(media!.base64.startsWith("data:")).toBe(false);
    expect(media!.orientation?.orientation).toBe(8);
  });

  it("declares upright for an image that carries no tag", async () => {
    const plain = concat(
      [0xff, 0xd8, 0xff, 0xdb, 0x00, 0x06, 0x00, 0x11, 0x22, 0x33],
      new Uint8Array(300),
      [0xff, 0xd9]
    );
    stubEvolution({ base64: b64(plain), mimetype: "image/jpeg" });

    const media = await fetchMediaBase64("traveller@example.com", { key: { id: "abc" } });
    expect(media!.orientation?.orientation).toBe(1);
    expect(media!.orientation?.source).toBe("none");
  });

  it("still returns the media when the bytes are hostile garbage", async () => {
    // The failure that must NOT happen: a throw here aborts processVendorReply
    // before the reply is stored, so one bad photo eats the whole conversation.
    const junk = Uint8Array.from(new Array(500), (_, i) => (i * 251) % 256);
    stubEvolution({ base64: b64(junk), mimetype: "image/jpeg" });

    const media = await fetchMediaBase64("traveller@example.com", { key: { id: "abc" } });
    expect(media).not.toBeNull();
    expect(media!.orientation?.orientation).toBe(1);
  });

  it("keeps returning null when Evolution has no bytes for the message", async () => {
    stubEvolution({ base64: "" });
    expect(await fetchMediaBase64("traveller@example.com", { key: { id: "x" } })).toBeNull();
  });

  it("keeps returning null when the host is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      })
    );
    expect(await fetchMediaBase64("traveller@example.com", { key: { id: "x" } })).toBeNull();
  });

  it("carries the audio path through untouched (orientation is meaningless there)", async () => {
    const ogg = concat(ASCII("OggS"), new Uint8Array(400));
    stubEvolution({ base64: b64(ogg), mimetype: "audio/ogg" });

    const media = await fetchMediaBase64("traveller@example.com", { key: { id: "x" } });
    expect(media!.mime).toBe("audio/ogg");
    expect(media!.base64).toBe(b64(ogg));
    expect(media!.orientation?.orientation).toBe(1);
  });
});
