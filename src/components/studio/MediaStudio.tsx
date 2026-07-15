"use client";

import { useState } from "react";
import { PlaceAutocomplete } from "../PlaceAutocomplete";
import { LoadingDots } from "../LoadingDots";

interface MediaResult {
  kind: string;
  transcript?: { text: string; language?: string; source: string } | null;
  extraction?: Record<string, unknown>;
  coherence?: { coherent: boolean; issues: string[]; correctedPricePerDay?: number; fromAi: boolean };
  floor?: { floor: number; typical?: number; currency: string } | null;
  note?: string;
  error?: string;
  visionAttempts?: { provider: string; model: string; ok: boolean; error?: string }[];
}

// The Media Testing Lab: upload a price-table / odometer / vehicle image OR a
// voice note and see EXACTLY what the vision / transcription agent read, plus
// the media-coherence verdict against optional conversation context. Full
// visibility into "can the agent really read this?" - no WhatsApp traffic.
export function MediaStudio() {
  const [kind, setKind] = useState<"image" | "audio">("image");
  const [region, setRegion] = useState("Bali, Indonesia");
  const [context, setContext] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [b64, setB64] = useState<string | null>(null);
  const [mime, setMime] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<MediaResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function onFile(file: File) {
    setErr(null);
    setResult(null);
    setFileName(file.name);
    if (kind === "image") {
      // Downscale to <= 1280px JPEG so the base64 stays under the body limit.
      const dataUrl = await downscaleImage(file, 1280);
      setMime("image/jpeg");
      setB64(dataUrl.split(",")[1] ?? "");
    } else {
      if (file.size > 3.5 * 1024 * 1024) {
        setErr("Audio too large - keep voice notes under ~3.5MB.");
        return;
      }
      const buf = await file.arrayBuffer();
      setMime(file.type || "audio/ogg");
      setB64(bufferToBase64(buf));
    }
  }

  async function run() {
    if (!b64) return;
    setBusy(true);
    setResult(null);
    setErr(null);
    try {
      const res = await fetch("/api/admin/graph/media-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, mime, base64: b64, region, context }),
      });
      const d = await res.json();
      if (d.error) setErr(d.error);
      else setResult(d);
    } catch {
      setErr("Request failed - the file may be too large.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="mb-2 flex gap-2">
        {(["image", "audio"] as const).map((k) => (
          <button
            key={k}
            onClick={() => {
              setKind(k);
              setB64(null);
              setFileName(null);
              setResult(null);
            }}
            className={`btn btn-sm flex-1 rounded-xl border-2 py-2 text-[13px] font-bold ${
              kind === k ? "border-brandblue bg-brandblue-soft text-brandblue" : "border-line text-soft"
            }`}
          >
            {k === "image" ? "🖼️ Image (prices / odometer / condition)" : "🎙️ Voice note"}
          </button>
        ))}
      </div>

      <div className="rounded-2xl border-2 border-line bg-card2 p-3">
        <label className="block cursor-pointer rounded-xl border-2 border-dashed border-line bg-card p-4 text-center text-[13px] font-bold text-brandblue">
          {fileName ? `📎 ${fileName}` : kind === "image" ? "Tap to choose an image" : "Tap to choose an audio file"}
          <input
            type="file"
            accept={kind === "image" ? "image/*" : "audio/*"}
            onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
            className="hidden"
          />
        </label>

        <div className="mt-2">
          <PlaceAutocomplete label="Shop region (accent / currency hint)" value={region} onText={setRegion} minChars={2} />
        </div>
        <label className="mt-2 block text-[12px] font-bold text-soft">
          Conversation context (optional - lets the coherence check compare)
          <textarea
            value={context}
            onChange={(e) => setContext(e.target.value)}
            rows={2}
            placeholder="e.g. We asked for a 125cc scooter for 3 days."
            className="mt-1 w-full rounded-xl border-2 border-line bg-card p-2 text-[13px] text-strong"
          />
        </label>
        <button
          onClick={run}
          disabled={busy || !b64}
          className="btn btn-primary mt-3 w-full rounded-2xl py-2.5 text-sm disabled:opacity-50"
        >
          {busy ? <LoadingDots light label="Reading the media" /> : "Run the agents on this media"}
        </button>
        {err && <div className="mt-2 rounded-lg bg-brandred/10 p-2 text-[12px] font-bold text-brandred">{err}</div>}
      </div>

      {result && (
        <div className="mt-3 space-y-2">
          {result.note && (
            <div className="rounded-xl bg-brandyellow-soft p-2.5 text-[12px] font-bold text-[#8a6100] dark:text-brandyellow">
              {result.note}
            </div>
          )}
          {result.visionAttempts && result.visionAttempts.length > 0 && (
            <div className="rounded-xl border border-line bg-card p-2.5">
              <div className="mb-1 text-[11px] font-extrabold text-strong">
                📡 Vision providers tried (exact upstream answers)
              </div>
              <div className="space-y-1">
                {result.visionAttempts.map((a, i) => (
                  <div key={i} className="flex items-start gap-1.5 text-[11px]">
                    <span className="shrink-0">{a.ok ? "✅" : "❌"}</span>
                    <span className="min-w-0">
                      <span className="font-bold text-strong">
                        {a.provider} · {a.model}
                      </span>
                      {a.error && <span className="block break-words text-brandred">{a.error}</span>}
                      {a.ok && <span className="block text-savings">answered - this reading is below</span>}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {result.transcript && (
            <div className="rounded-xl border border-line bg-card p-2.5">
              <div className="text-[11px] font-extrabold text-strong">
                🎙️ Transcription ({result.transcript.source}
                {result.transcript.language ? ` · ${result.transcript.language}` : ""})
              </div>
              <div className="mt-1 text-[13px] text-soft">{result.transcript.text}</div>
            </div>
          )}
          {result.extraction && (
            <div className="rounded-xl border border-line bg-card p-2.5">
              <div className="mb-1 text-[11px] font-extrabold text-strong">🔎 What the extractor read</div>
              <pre className="overflow-x-auto rounded-lg bg-card2 p-2 text-[11px] text-soft">
                {JSON.stringify(result.extraction, null, 2)}
              </pre>
            </div>
          )}
          {result.coherence && (
            <div
              className={`rounded-xl border-2 p-2.5 ${
                result.coherence.coherent ? "border-savings bg-savings-soft" : "border-brandred bg-brandred/10"
              }`}
            >
              <div className="text-[12px] font-extrabold text-strong">
                🧿 Coherence: {result.coherence.coherent ? "consistent with the conversation" : "NOT consistent"}
                {result.coherence.fromAi ? "" : " (deterministic)"}
              </div>
              {result.coherence.issues.length > 0 && (
                <ul className="mt-1 list-disc pl-4 text-[12px] text-soft">
                  {result.coherence.issues.map((iss, i) => (
                    <li key={i}>{iss}</li>
                  ))}
                </ul>
              )}
              {result.coherence.correctedPricePerDay != null && (
                <div className="mt-1 text-[12px] font-bold text-brandblue">
                  Corrected price/day: {result.coherence.correctedPricePerDay}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

async function downscaleImage(file: File, maxDim: number): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = reject;
      im.src = url;
    });
    const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
    const w = Math.round(img.width * scale);
    const h = Math.round(img.height * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d")?.drawImage(img, 0, 0, w, h);
    return canvas.toDataURL("image/jpeg", 0.82);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function bufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
