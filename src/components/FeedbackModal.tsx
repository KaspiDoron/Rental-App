"use client";

import { useRef, useState } from "react";
import { Modal } from "./Modal";
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
    <Modal onClose={onClose}>
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-brandblue-soft">
            <Icon name="chat" className="h-4 w-4 text-brandblue" />
          </div>
          <h2 className="text-lg font-extrabold text-strong">Send feedback</h2>
        </div>
        <button onClick={onClose} className="btn btn-sm btn-ghost rounded-xl px-3" aria-label="Close">
          ✕
        </button>
      </div>

      {!done ? (
        <>
          <p className="mb-3 text-[12px] text-soft">
            Found a bug or rough edge? Our assistant filters real issues through
            to the team, so genuine reports never get lost in noise.
          </p>

          <div className="no-scrollbar mb-3 flex gap-2 overflow-x-auto">
            {CATEGORIES.map((c) => (
              <button
                key={c.id}
                onClick={() => setCategory(c.id)}
                className={`chip whitespace-nowrap rounded-full border-2 px-3 py-1.5 text-[12px] font-bold ${
                  category === c.id
                    ? "border-brandblue bg-brandblue text-white"
                    : "border-line bg-card text-soft"
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
            className="w-full resize-none rounded-2xl border-2 border-line bg-card p-3 text-sm text-strong placeholder:text-faint focus:border-brandblue focus:outline-none"
          />

          <div className="mt-2 flex items-center justify-between">
            <button
              onClick={assist}
              disabled={assisting || !text.trim()}
              className="btn btn-sm chip inline-flex items-center gap-1.5 rounded-xl border-2 border-brandred/30 bg-brandred-soft px-2.5 py-1.5 text-[12px] font-bold text-brandred disabled:opacity-50"
            >
              <Icon name="spark" className="h-3.5 w-3.5" />
              {assisting ? "Writing..." : "Write it for me"}
            </button>
            <span className="text-[11px] text-faint">{text.length}/4000</span>
          </div>

          <div className="mt-3">
            <div className="mb-1.5 text-[12px] font-bold text-soft">
              Screenshots ({images.length}/{MAX_IMAGES})
            </div>
            <div className="flex flex-wrap gap-2">
              {images.map((img, i) => (
                <div key={i} className="relative h-16 w-16 overflow-hidden rounded-xl border-2 border-line">
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
                  className="btn flex h-16 w-16 items-center justify-center rounded-xl border-2 border-dashed border-line text-faint hover:border-brandblue hover:text-brandblue"
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
            <p className="mt-2 text-[12px] font-semibold text-brandred">{status.msg}</p>
          )}

          <button
            onClick={submit}
            disabled={status.s === "sending" || text.trim().length < 3}
            className="btn btn-primary mt-4 w-full rounded-2xl py-3 text-sm disabled:opacity-60"
          >
            {status.s === "sending" ? "Sending..." : "Submit feedback"}
          </button>
        </>
      ) : (
        <div className="py-6 text-center">
          <div
            className={`mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full ${
              status.s === "accepted" ? "bg-savings-soft" : "bg-brandyellow-soft"
            }`}
          >
            <Icon
              name={status.s === "accepted" ? "check" : "shield"}
              className={`h-8 w-8 ${
                status.s === "accepted" ? "text-savings" : "text-brandyellow"
              }`}
            />
          </div>
          {status.s === "accepted" ? (
            <>
              <p className="text-sm font-extrabold text-strong">Thanks - this one is on us.</p>
              <p className="mt-1 text-[13px] text-soft">
                Verified as a real issue
                {status.emailed ? " and emailed to the team." : " and logged for the team."}
              </p>
            </>
          ) : (
            <p className="text-[13px] text-soft">{status.reason}</p>
          )}
          <button onClick={onClose} className="btn btn-primary mt-4 w-full rounded-2xl py-2.5 text-sm">
            Done
          </button>
        </div>
      )}
    </Modal>
  );
}
