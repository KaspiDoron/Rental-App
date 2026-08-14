import "server-only";

// THE AUDIT COPY, ON THE RUNTIME THAT ACTUALLY RUNS.
//
// WhatsApp expires media after a while. The vision WORKER kept a redeemable
// copy in Supabase Storage - and the worker is deployed nowhere, so on the
// live inline path every photo went un-audited and "Full conversation" lost
// the picture the moment upstream expired it. This is the worker's own
// storeMediaAudit (vision.worker.ts), verbatim in contract: deterministic
// path keyed on the provider message id, best-effort, never throws, never
// slows the turn (call it fire-and-forget).
//
// /api/wa/media reads these back by trying `wa-media/<id>.<ext>` - keep the
// extension map in step with its AUDIT_EXTS list.

export async function storeMediaAudit(
  waMessageId: string,
  media: { mime: string; base64: string }
): Promise<string | undefined> {
  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key || !waMessageId) return undefined;
  try {
    const mime = media.mime || "image/jpeg";
    const ext = mime.includes("png")
      ? "png"
      : mime.includes("webp")
      ? "webp"
      : mime.includes("pdf")
      ? "pdf"
      : mime.includes("mp4")
      ? "mp4"
      : mime.includes("ogg")
      ? "ogg"
      : "jpg";
    const path = `wa-media/${waMessageId}.${ext}`;
    const res = await fetch(`${base}/storage/v1/object/${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": mime,
        "x-upsert": "true",
      },
      body: Buffer.from(media.base64, "base64"),
    });
    return res.ok ? path : undefined;
  } catch {
    return undefined;
  }
}
