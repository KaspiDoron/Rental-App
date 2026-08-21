import { getSession } from "@/lib/session";
import { sbSelect } from "@/lib/runtime-config";
import { readOrientation, UPRIGHT } from "@/lib/media/orientation";
import type { OrientationInfo } from "@/lib/media/orientation";

// SHOP MEDIA PROXY - the bytes behind a "[photo]" row in Full conversation.
//
// Nothing new is stored to make this work. The row already carries the
// provider message KEY in `raw.media` (ingest.ts), and WhatsApp still holds the
// bytes; this route redeems the one for the other on demand. When WhatsApp has
// expired the media, it falls back to the audit copy the vision worker already
// wrote to Supabase Storage.
//
// Two hard rules, both mirroring /api/negotiate/consent:
//   - The row must be INBOUND TO THIS USER (`raw->>receiver=eq.<email>`). The
//     same message id in another traveller's thread is a 404 here.
//   - The response is `private` (browser-only cache, one hour): a shop's
//     price board is one traveller's negotiation intel, never a shared CDN
//     object - but the bytes behind one message id are immutable, and
//     re-redeeming them on every panel open was the 10-second photo pop.
export const dynamic = "force-dynamic";

// A WhatsApp message id is base32-ish. Anything else is rejected before a
// single upstream call - the /api/photo discipline: never interpolate an
// unvalidated value into a URL.
const ID_RX = /^[A-Za-z0-9_-]{4,80}$/;
// Keep in step with lib/media/audit.ts (inline path) AND the vision worker -
// pdf/mp4/ogg joined when the inline path started auditing every media kind.
const AUDIT_EXTS = ["jpg", "png", "webp", "pdf", "mp4", "ogg"] as const;

type MediaRow = {
  wa_message_id: string | null;
  type: string | null;
  raw: { media?: { key?: unknown; kind?: string; mime?: string | null } } | null;
};

function contentTypeFor(kind: string | undefined, mime: string | null | undefined): string {
  if (mime && /^[\w.+-]+\/[\w.+-]+$/.test(mime)) return mime;
  if (kind === "audio") return "audio/ogg";
  return "image/jpeg";
}

// WHICH WAY IS THE BOARD UP. The bytes we serve are the shop's originals, EXIF
// and all - this route never rewrites an image (see lib/media/orientation.ts).
// Declaring the parsed tag on the response makes the property observable end to
// end: an `<img>` cannot read a header, but the admin surfaces, the audit replay
// and the test suite can, so "the photo came in sideways" stops being a thing
// only the traveller's eyes know.
const ORIENTATION_HEADER = "X-Image-Orientation";

function orientationHeaders(info: OrientationInfo): Record<string, string> {
  return { [ORIENTATION_HEADER]: String(info.orientation) };
}

/** The audit copy the ingest wrote - the FAST source (~200-500ms from storage). */
async function auditCopy(waMessageId: string): Promise<Response | null> {
  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) return null;
  // TWO NAMES, ONE FILE. The vision worker stores a coalesced burst as
  // `<id>-<i>.<ext>` (it can hold several frames per message) while this route
  // only ever asked for `<id>.<ext>` - so once WhatsApp expired the bytes,
  // every audit copy the worker HAD saved was unreachable and the photo was
  // permanently blank. Try the frame-indexed name too; frame 0 is the leader.
  //
  // PROBED IN PARALLEL. The sequential 2x6 loop with a 10s timeout each was a
  // worst case of ~2 MINUTES before the traveller learned the photo was gone.
  // Exactly one candidate exists, so cheap HEADs race and only the winner is
  // fetched.
  const names = [waMessageId, `${waMessageId}-0`];
  const candidates = AUDIT_EXTS.flatMap((ext) => names.map((name) => `${name}.${ext}`));
  const winner = await Promise.any(
    candidates.map(async (path) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5_000);
      try {
        const res = await fetch(`${base}/storage/v1/object/wa-media/${path}`, {
          method: "HEAD",
          headers: { authorization: `Bearer ${key}` },
          cache: "no-store",
          signal: ctrl.signal,
        });
        if (!res.ok) throw new Error(String(res.status));
        return path;
      } finally {
        clearTimeout(timer);
      }
    })
  ).catch(() => null);
  if (!winner) return null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    try {
      const res = await fetch(`${base}/storage/v1/object/wa-media/${winner}`, {
        headers: { authorization: `Bearer ${key}` },
        cache: "no-store",
        signal: ctrl.signal,
      });
      if (res.ok && res.body) return res;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    /* fall through to the live path */
  }
  return null;
}

export async function GET(req: Request) {
  const session = await getSession();
  if (!session) return new Response(null, { status: 401 });

  const id = new URL(req.url).searchParams.get("id") ?? "";
  if (!ID_RX.test(id)) return new Response(null, { status: 400 });

  // PRIVACY GATE: this must be a message THIS user's WhatsApp received.
  const rows = await sbSelect<MediaRow>(
    "whatsapp_messages",
    `select=wa_message_id,type,raw&direction=eq.inbound&wa_message_id=eq.${encodeURIComponent(
      id
    )}&raw->>receiver=eq.${encodeURIComponent(session.email)}&limit=1`
  ).catch(() => []);
  const row = rows[0];
  if (!row) return new Response(null, { status: 404 });

  const media = row.raw?.media;
  const ct = contentTypeFor(media?.kind, media?.mime);
  // PRIVATE but CACHEABLE: the bytes behind one message id never change, and
  // `no-store` forced the full redemption on EVERY reopen of the panel - the
  // ~10-second photo pop the owner filmed, repeated each visit. An hour in the
  // traveller's own browser cache leaks nothing (the response stays private).
  const headers = { "Content-Type": ct, "Cache-Control": "private, max-age=3600" };

  // 1) AUDIT COPY FIRST. The ingest already wrote these bytes to storage at
  //    receive time; serving them is a ~200-500ms object read. The old order
  //    asked Evolution first - waking a possibly-cold host to download and
  //    re-encrypt from the WhatsApp CDN under a 12s ceiling - for bytes that
  //    were already sitting in our own bucket.
  //    Buffered rather than streamed, because the orientation declaration has
  //    to come from these bytes: the audit copy is a straight byte-for-byte
  //    replay with no ingest record attached. Media is capped upstream.
  const audit = await auditCopy(id);
  if (audit) {
    const buf = Buffer.from(await audit.arrayBuffer());
    return new Response(buf, {
      headers: {
        ...headers,
        "Content-Type": audit.headers.get("Content-Type") ?? ct,
        ...orientationHeaders(readOrientation(buf)),
      },
    });
  }

  // 2) No audit copy (audit failed at ingest, or pre-audit row) - redeem live
  //    from WhatsApp; the key is all Evolution needs to find the message.
  if (media?.key) {
    const { fetchMediaBase64 } = await import("@/lib/evolution");
    const live = await fetchMediaBase64(session.email, { key: media.key }).catch(() => null);
    if (live?.base64) {
      // The ingest chokepoint already measured this; re-parsing here would be a
      // second, divergent opinion about the same bytes.
      return new Response(Buffer.from(live.base64, "base64"), {
        headers: {
          ...headers,
          "Content-Type": contentTypeFor(media.kind, live.mime),
          ...orientationHeaders(live.orientation ?? UPRIGHT),
        },
      });
    }
  }
  return new Response(null, { status: 404 });
}
