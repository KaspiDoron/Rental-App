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
//   - The response is `private, no-store`. A shop's price board is one
//     traveller's negotiation intel, never a shared CDN object.
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

/** The audit copy the vision worker wrote, if WhatsApp no longer has the bytes. */
async function auditCopy(waMessageId: string): Promise<Response | null> {
  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) return null;
  // TWO NAMES, ONE FILE. The vision worker stores a coalesced burst as
  // `<id>-<i>.<ext>` (it can hold several frames per message) while this route
  // only ever asked for `<id>.<ext>` - so once WhatsApp expired the bytes,
  // every audit copy the worker HAD saved was unreachable and the photo was
  // permanently blank. Try the frame-indexed name too; frame 0 is the leader.
  const names = [waMessageId, `${waMessageId}-0`];
  for (const ext of AUDIT_EXTS) {
    for (const name of names) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 10_000);
        let res: Response;
        try {
          res = await fetch(`${base}/storage/v1/object/wa-media/${name}.${ext}`, {
            headers: { authorization: `Bearer ${key}` },
            cache: "no-store",
            signal: ctrl.signal,
          });
        } finally {
          clearTimeout(timer);
        }
        if (res.ok && res.body) return res;
      } catch {
        /* try the next name / extension */
      }
    }
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
  const headers = { "Content-Type": ct, "Cache-Control": "private, no-store" };

  // 1) Live from WhatsApp - the key is all Evolution needs to find the message.
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

  // 2) Expired upstream - serve the audit copy if the vision worker kept one.
  //    Buffered rather than streamed, because the orientation declaration has to
  //    come from these bytes: the audit copy is a straight byte-for-byte replay
  //    with no ingest record attached, so an un-inspected stream would be the
  //    one path that serves a sideways board with no answer at all. Media is
  //    capped upstream, so this is bounded by the same limit the live path is.
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
  return new Response(null, { status: 404 });
}
