"use client";

import { useCallback, useEffect, useState } from "react";
import { Modal } from "./Modal";
import { Icon } from "./icons";
import { LoadingDots } from "./LoadingDots";
import { normalizeImageFile } from "@/lib/client/normalize-image";

const CATEGORIES = [
  { id: "bug", label: "Bug" },
  { id: "ui", label: "UI / layout" },
  { id: "performance", label: "Slow / performance" },
  { id: "crash", label: "Crash / blank" },
  { id: "suggestion", label: "Suggestion" },
  { id: "question", label: "Question" },
  { id: "other", label: "Other" },
];

const MAX_IMAGES = 5;
const SEEN_KEY = "wd_fb_seen";

const STATUS_META: Record<string, { label: string; cls: string }> = {
  open: { label: "Open", cls: "bg-brandblue-soft text-brandblue" },
  "in-progress": { label: "In progress", cls: "bg-brandyellow-soft text-[#8a6100] dark:text-brandyellow" },
  resolved: { label: "Resolved", cls: "bg-savings-soft text-savings" },
  dismissed: { label: "Closed", cls: "bg-card2 text-faint" },
};

interface Reply {
  id: number;
  feedback_id: number;
  author_role: string;
  body: string;
  created_at: string;
}
interface Report {
  id: number;
  category: string;
  body: string;
  status: string | null;
  severity: string | null;
  summary: string | null;
  created_at: string;
  replies: Reply[];
}

// A bug report's screenshot is usually a photo of the phone's own screen, taken
// with another phone - which is exactly the EXIF-tagged case. The local
// new Image() + drawImage + toDataURL helper that used to live here destroyed
// that tag irreversibly (canvas writes no metadata) while trusting the engine to
// have applied it during decode; where it had not, the triage team received a
// sideways screenshot and no way to recover. normalizeImageFile is the shared,
// spec-guaranteed version - same budget as before, upright by construction.
const SHOT = { maxDim: 1100, quality: 0.7, maxBytes: 900_000 } as const;

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function FeedbackModal({ email, onClose }: { email?: string; onClose: () => void }) {
  const [tab, setTab] = useState<"new" | "yours">("new");
  const [reports, setReports] = useState<Report[] | null>(null);
  const [reportsError, setReportsError] = useState<string | null>(null);
  const [hasUnread, setHasUnread] = useState(false);

  const loadReports = useCallback(async () => {
    setReportsError(null);
    try {
      const res = await fetch("/api/feedback", { method: "GET" });
      if (res.status === 401) {
        setReports([]);
        setReportsError("Sign in to see and manage your reports.");
        return;
      }
      const data = await res.json();
      const list: Report[] = Array.isArray(data.reports) ? data.reports : [];
      setReports(list);
      // Unread = a team reply newer than the last time this device looked.
      const seen = Number(localStorage.getItem(SEEN_KEY) ?? 0);
      const newestTeam = list
        .flatMap((r) => r.replies)
        .filter((rp) => rp.author_role !== "user")
        .reduce((mx, rp) => Math.max(mx, Date.parse(rp.created_at) || 0), 0);
      setHasUnread(newestTeam > seen);
    } catch {
      setReports([]);
      setReportsError("Could not load your reports - check your connection.");
    }
  }, []);

  // Peek once on open so the tab can show an unread dot without switching.
  useEffect(() => {
    loadReports();
  }, [loadReports]);

  const openYours = () => {
    setTab("yours");
    try {
      localStorage.setItem(SEEN_KEY, String(Date.now()));
    } catch {}
    setHasUnread(false);
    loadReports();
  };

  return (
    <Modal onClose={onClose}>
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-brandblue-soft">
            <Icon name="chat" className="h-4 w-4 text-brandblue" />
          </div>
          <h2 className="text-lg font-extrabold text-strong">Feedback</h2>
        </div>
        <button onClick={onClose} className="btn btn-sm btn-ghost rounded-xl px-3" aria-label="Close">
          ✕
        </button>
      </div>

      {/* Segmented control - compose a new report or manage your own thread. */}
      <div className="mb-3 flex gap-1 rounded-2xl bg-card2 p-1">
        <button
          onClick={() => setTab("new")}
          className={`flex-1 rounded-xl py-2 text-[13px] font-extrabold transition-colors ${
            tab === "new" ? "bg-card text-strong shadow-sm" : "text-soft"
          }`}
        >
          Send new
        </button>
        <button
          onClick={openYours}
          className={`relative flex-1 rounded-xl py-2 text-[13px] font-extrabold transition-colors ${
            tab === "yours" ? "bg-card text-strong shadow-sm" : "text-soft"
          }`}
        >
          Your reports
          {hasUnread && tab !== "yours" && (
            <span className="absolute right-2 top-1.5 h-2 w-2 rounded-full bg-brandred" aria-label="new reply" />
          )}
        </button>
      </div>

      {tab === "new" ? (
        <ComposeTab email={email} onSubmitted={loadReports} onSeeYours={openYours} />
      ) : (
        <ReportsTab
          reports={reports}
          error={reportsError}
          onChanged={loadReports}
        />
      )}
    </Modal>
  );
}

function ComposeTab({
  email,
  onSubmitted,
  onSeeYours,
}: {
  email?: string;
  onSubmitted: () => void;
  onSeeYours: () => void;
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

  async function addFiles(files: FileList | null) {
    if (!files) return;
    const room = MAX_IMAGES - images.length;
    const chosen = Array.from(files).slice(0, room);
    const next: { filename: string; dataUrl: string }[] = [];
    for (const f of chosen) {
      const shot = await normalizeImageFile(f, SHOT);
      // An unreadable file yields an empty data URL rather than a throw.
      if (shot.dataUrl) next.push({ filename: f.name, dataUrl: shot.dataUrl });
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
        onSubmitted();
      } else {
        setStatus({ s: "filtered", reason: data.reason });
        onSubmitted();
      }
    } catch {
      setStatus({ s: "error", msg: "Network error. Please try again." });
    }
  }

  const done = status.s === "accepted" || status.s === "filtered";
  if (done) {
    return (
      <div className="py-6 text-center">
        <div
          className={`mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full ${
            status.s === "accepted" ? "bg-savings-soft" : "bg-brandyellow-soft"
          }`}
        >
          <Icon
            name={status.s === "accepted" ? "check" : "shield"}
            className={`h-8 w-8 ${status.s === "accepted" ? "text-savings" : "text-brandyellow"}`}
          />
        </div>
        {status.s === "accepted" ? (
          <>
            <p className="text-sm font-extrabold text-strong">Thanks - this one is on us.</p>
            <p className="mt-1 text-[13px] text-soft">
              Verified as a real issue
              {status.emailed ? " and emailed to the team." : " and logged for the team."} You can
              follow it under Your reports.
            </p>
          </>
        ) : (
          <p className="text-[13px] text-soft">{status.reason}</p>
        )}
        <button
          onClick={onSeeYours}
          className="btn btn-primary mt-4 w-full rounded-2xl py-2.5 text-sm"
        >
          See your reports
        </button>
      </div>
    );
  }

  return (
    <>
      <p className="mb-3 text-[12px] text-soft">
        Bug, idea, question or complaint - tell us anything. You will see it under Your reports and
        the team can reply right there.
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
        className="w-full resize-none rounded-2xl border-2 border-line bg-card p-3 text-sm text-strong placeholder:text-faint transition-colors focus:border-brandblue focus:outline-none"
      />

      <div className="mt-2 flex items-center justify-between">
        <button
          type="button"
          onClick={assist}
          disabled={assisting || !text.trim()}
          className="btn btn-sm chip inline-flex items-center gap-1.5 rounded-xl border-2 border-brandred/30 bg-brandred-soft px-2.5 py-1.5 text-[12px] font-bold text-brandred disabled:opacity-50"
        >
          <Icon name="spark" className="h-3.5 w-3.5" />
          {assisting ? <LoadingDots label="Writing" /> : "Write it for me"}
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
            <label
              className="btn flex h-16 w-16 cursor-pointer items-center justify-center rounded-xl border-2 border-dashed border-line text-faint hover:border-brandblue hover:text-brandblue"
              aria-label="Add screenshot"
            >
              <input
                type="file"
                accept="image/*"
                multiple
                className="sr-only"
                onChange={(e) => {
                  addFiles(e.target.files);
                  e.target.value = "";
                }}
              />
              <Icon name="plus" className="h-5 w-5" />
            </label>
          )}
        </div>
      </div>

      {status.s === "error" && (
        <p className="mt-2 text-[12px] font-semibold text-brandred">{status.msg}</p>
      )}

      <button
        type="button"
        onClick={submit}
        disabled={status.s === "sending" || text.trim().length < 3}
        className="btn btn-primary mt-4 w-full rounded-2xl py-3 text-sm disabled:opacity-60"
      >
        {status.s === "sending" ? (
          <LoadingDots light label="Sending your feedback" />
        ) : (
          "Submit feedback"
        )}
      </button>
    </>
  );
}

function ReportsTab({
  reports,
  error,
  onChanged,
}: {
  reports: Report[] | null;
  error: string | null;
  onChanged: () => void;
}) {
  if (reports === null) {
    return (
      <div className="py-8 text-center">
        <LoadingDots label="Loading your reports" />
      </div>
    );
  }
  if (error) {
    return <p className="py-8 text-center text-[13px] text-soft">{error}</p>;
  }
  if (reports.length === 0) {
    return (
      <div className="py-8 text-center">
        <p className="text-[13px] font-extrabold text-strong">No reports yet</p>
        <p className="mx-auto mt-1 max-w-[260px] text-[12px] text-soft">
          Anything you send appears here as a conversation you can follow and reply to.
        </p>
      </div>
    );
  }
  return (
    <div className="no-scrollbar max-h-[55vh] space-y-2.5 overflow-y-auto">
      {reports.map((r) => (
        <ReportRow key={r.id} report={r} onChanged={onChanged} />
      ))}
    </div>
  );
}

function ReportRow({ report, onChanged }: { report: Report; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const status = report.status ?? "open";
  const meta = STATUS_META[status] ?? STATUS_META.open;

  async function sendReply() {
    if (!reply.trim() || busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/feedback/reply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ feedbackId: report.id, body: reply.trim() }),
      });
      if (res.ok) {
        setReply("");
        onChanged();
      }
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/feedback?id=${report.id}`, { method: "DELETE" });
      if (res.ok) onChanged();
    } finally {
      setBusy(false);
      setConfirmDel(false);
    }
  }

  const teamReplies = report.replies.filter((rp) => rp.author_role !== "user").length;

  return (
    <div className="surface rounded-2xl p-3">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-start justify-between gap-2 text-left"
      >
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-extrabold ${meta.cls}`}>
              {meta.label}
            </span>
            <span className="text-[10px] font-bold uppercase tracking-wide text-faint">
              {report.category}
            </span>
            {teamReplies > 0 && (
              <span className="inline-flex items-center gap-0.5 text-[10px] font-bold text-brandblue">
                <Icon name="chat" className="h-3 w-3" /> {teamReplies}
              </span>
            )}
          </div>
          <p className="mt-1 line-clamp-2 text-[13px] font-semibold text-strong">
            {report.summary || report.body}
          </p>
        </div>
        <span className="shrink-0 text-[10px] text-faint">{fmtDate(report.created_at)}</span>
      </button>

      {open && (
        <div className="mt-2.5 border-t border-line pt-2.5">
          <p className="whitespace-pre-wrap text-[12px] text-soft">{report.body}</p>

          {report.replies.length > 0 && (
            <div className="mt-2.5 space-y-1.5">
              {report.replies.map((rp) => {
                const mine = rp.author_role === "user";
                return (
                  <div key={rp.id} className={`flex ${mine ? "justify-end" : "justify-start"}`}>
                    <div
                      className={`max-w-[85%] rounded-2xl px-3 py-1.5 text-[12px] ${
                        mine
                          ? "rounded-br-md bg-brandblue text-white"
                          : "rounded-bl-md bg-card2 text-strong"
                      }`}
                    >
                      {!mine && (
                        <div className="text-[9px] font-extrabold uppercase tracking-wide text-brandblue">
                          {rp.author_role === "owner" ? "WheelDeal team" : "Support"}
                        </div>
                      )}
                      <p className="whitespace-pre-wrap">{rp.body}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {status !== "dismissed" && (
            <div className="mt-2.5 flex items-center gap-1.5">
              <input
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") sendReply();
                }}
                disabled={busy}
                placeholder="Reply to the team..."
                className="h-10 min-w-0 flex-1 rounded-xl border-2 border-line bg-card px-3 text-sm text-strong placeholder:text-faint transition-colors focus:border-brandblue focus:outline-none disabled:opacity-60"
                style={{ fontSize: "16px" }}
              />
              <button
                onClick={sendReply}
                disabled={busy || !reply.trim()}
                className="btn btn-primary h-10 shrink-0 rounded-xl px-3 disabled:opacity-50"
                aria-label="Send reply"
              >
                <Icon name="send" className="h-4 w-4" />
              </button>
            </div>
          )}

          <div className="mt-2 flex justify-end">
            {confirmDel ? (
              <div className="flex items-center gap-2 text-[11px]">
                <span className="text-soft">Delete this report?</span>
                <button onClick={remove} disabled={busy} className="font-extrabold text-brandred">
                  Delete
                </button>
                <button onClick={() => setConfirmDel(false)} className="font-bold text-faint">
                  Cancel
                </button>
              </div>
            ) : (
              <button
                onClick={() => setConfirmDel(true)}
                className="text-[11px] font-bold text-faint hover:text-brandred"
              >
                Delete report
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
