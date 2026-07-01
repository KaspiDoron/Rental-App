"use client";

import { useRef, useState } from "react";
import { Icon } from "./icons";

const CATEGORIES = [
  { id: "bug", label: "Bug" },
  { id: "ui", label: "UI / layout" },
  { id: "performance", label: "Slow / performance" },
  { id: "crash", label: "Crash / blank" },
  { id: "suggestion", label: "Suggestion" },
  { id: "other", label: "Other" },
];

const MAX_IMAGES = 5;

/** Downscale + compress an image file to a small JPEG data URL. */
function compress(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const max = 1100;
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        const ctx = canvas.getContext("2d");
        if (!ctx) return reject();
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", 0.7));
      };
      img.onerror = reject;
      img.src = reader.result as string;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export function FeedbackModal({
  email,
  onClose,
}: {
  email?: string;
  onClose: () => void;
}) {
  const [category, setCategory] = useState("bug");
  const [text, setText] = useState("");
  const [images, setImages] = useState<{ filename: string; dataUrl: string }[]>([]);
  const [assisting, setAssisting] = useState(false);
  const [status, setStatus] = useState<
    | { s: "idle" }
    | { s: "sending" }
    | { s: "accepted"; emailed: boolean; summary: string }
    | { s: "filtered"; reason: string }
    | { s: "error"; msg: string }
  >({ s: "idle" });
  const fileRef = useRef<HTMLInputElement>(null);

  async function addFiles(files: FileList | null) {
    if (!files) return;
    const room = MAX_IMAGES - images.length;
    const chosen = Array.from(files).slice(0, room);
    const next: { filename: string; dataUrl: string }[] = [];
    for (const f of chosen) {
      try {
        next.push({ filename: f.name, dataUrl: await compress(f) });
      } catch {
        /* ignore unreadable file */
      }
    }
    setImages((prev) => [...prev, ...next].slice(0, MAX_IMAGES));
  }

  async function assist() {
    if (!text.trim()) return;
    setAssisting(true);
    try {
      const res = await fetch("/api/feedback/assist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category, notes: text }),
      });
      const data = await res.json();
      if (data.text) setText(data.text);
    } finally {
      setAssisting(false);
    }
  }

  async function submit() {
    if (text.trim().length < 3) return;
    setStatus({ s: "sending" });
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category, text, email, images }),
      });
      const data = await res.json();
      if (!res.ok) {
        setStatus({ s: "error", msg: data.error ?? "Something went wrong." });
      } else if (data.accepted) {
        setStatus({ s: "accepted", emailed: data.emailed, summary: data.summary });
      } else {
        setStatus({ s: "filtered", reason: data.reason });
      }
    } catch {
      setStatus({ s: "error", msg: "Network error. Please try again." });
    }
  }

  const done = status.s === "accepted" || status.s === "filtered";

  return (
    <div className="fixed inset-0 z-[1200] flex items-end justify-center bg-black/60 backdrop-blur-sm sm:items-center">
      <div className="surface-strong max-h-[92dvh] w-full max-w-md overflow-y-auto rounded-t-3xl p-5 pb-safe sm:rounded-3xl animate-slide-up">
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-savings/15">
              <Icon name="chat" className="h-4 w-4 text-savings-bright" />
            </div>
            <h2 className="text-lg font-bold text-white">Send feedback</h2>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white" aria-label="Close">
            ✕
          </button>
        </div>

        {!done ? (
          <>
            <p className="mb-3 text-[12px] text-slate-400">
              Found a bug or rough edge? Our assistant filters real issues through
              to the team, so genuine reports never get lost in noise.
            </p>

            <div className="no-scrollbar mb-3 flex gap-2 overflow-x-auto">
              {CATEGORIES.map((c) => (
                <button
                  key={c.id}
                  onClick={() => setCategory(c.id)}
                  className={`whitespace-nowrap rounded-full border px-3 py-1.5 text-[12px] font-medium transition ${
                    category === c.id
                      ? "border-savings/50 bg-savings/15 text-savings-bright"
                      : "border-slate-700/50 bg-ink/40 text-slate-300"
                  }`}
                >
                  {c.label}
                </button>
              ))}
            </div>

            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={4}
              maxLength={4000}
              placeholder="What happened? Steps to reproduce, what you expected..."
              className="w-full resize-none rounded-xl border border-slate-700/50 bg-ink/60 p-3 text-sm text-white placeholder:text-slate-600 focus:border-savings/50 focus:outline-none"
            />

            <div className="mt-2 flex items-center justify-between">
              <button
                onClick={assist}
                disabled={assisting || !text.trim()}
                className="inline-flex items-center gap-1.5 rounded-lg border border-violet-400/25 bg-violet-500/10 px-2.5 py-1.5 text-[12px] font-medium text-violet-200 disabled:opacity-50"
              >
                <Icon name="spark" className="h-3.5 w-3.5" />
                {assisting ? "Writing..." : "Write it for me"}
              </button>
              <span className="text-[11px] text-slate-500">{text.length}/4000</span>
            </div>

            {/* Image attachments */}
            <div className="mt-3">
              <div className="mb-1.5 flex items-center justify-between text-[12px] text-slate-400">
                <span>Screenshots ({images.length}/{MAX_IMAGES})</span>
              </div>
              <div className="flex flex-wrap gap-2">
                {images.map((img, i) => (
                  <div key={i} className="relative h-16 w-16 overflow-hidden rounded-lg border border-slate-700/50">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={img.dataUrl} alt="" className="h-full w-full object-cover" />
                    <button
                      onClick={() => setImages((p) => p.filter((_, j) => j !== i))}
                      className="absolute right-0 top-0 flex h-5 w-5 items-center justify-center bg-black/60 text-[11px] text-white"
                      aria-label="Remove image"
                    >
                      ✕
                    </button>
                  </div>
                ))}
                {images.length < MAX_IMAGES && (
                  <button
                    onClick={() => fileRef.current?.click()}
                    className="flex h-16 w-16 items-center justify-center rounded-lg border border-dashed border-slate-600/60 text-slate-400 hover:bg-slate-700/20"
                    aria-label="Add screenshot"
                  >
                    <Icon name="plus" className="h-5 w-5" />
                  </button>
                )}
              </div>
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                multiple
                hidden
                onChange={(e) => addFiles(e.target.files)}
              />
            </div>

            {status.s === "error" && (
              <p className="mt-2 text-[12px] text-rose-300">{status.msg}</p>
            )}

            <button
              onClick={submit}
              disabled={status.s === "sending" || text.trim().length < 3}
              className="btn-primary mt-4 w-full rounded-xl py-3 text-sm disabled:opacity-60"
            >
              {status.s === "sending" ? "Sending..." : "Submit feedback"}
            </button>
          </>
        ) : (
          <div className="py-6 text-center">
            <div
              className={`mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full ${
                status.s === "accepted" ? "bg-savings/15" : "bg-amber-500/15"
              }`}
            >
              <Icon
                name={status.s === "accepted" ? "check" : "shield"}
                className={`h-8 w-8 ${status.s === "accepted" ? "text-savings-bright" : "text-amber-300"}`}
              />
            </div>
            {status.s === "accepted" ? (
              <>
                <p className="text-sm font-semibold text-white">Thanks - this one is on us.</p>
                <p className="mt-1 text-[13px] text-slate-400">
                  Verified as a real issue{status.emailed ? " and emailed to the team" : " and logged for the team"}.
                </p>
              </>
            ) : (
              <p className="text-[13px] text-slate-300">{status.reason}</p>
            )}
            <button
              onClick={onClose}
              className="mt-4 w-full rounded-xl bg-slate-100/95 py-2.5 text-sm font-semibold text-ink"
            >
              Done
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
