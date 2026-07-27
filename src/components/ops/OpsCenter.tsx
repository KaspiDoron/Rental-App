"use client";

// The AI Operations Center - the owner's cockpit for continuously improving
// the negotiation agents from REAL production conversations. Owner-only
// (never a customer surface): review queue, full cross-user conversation
// review with per-decision reasoning, and (later phases) policy versioning,
// golden replay gates and effectiveness analytics.

import { useCallback, useEffect, useState } from "react";
import { LoadingDots } from "../LoadingDots";
import { ConversationPanel } from "./ConversationPanel";
import { PolicyPanel } from "./PolicyPanel";
import { AnalyticsPanel } from "./AnalyticsPanel";
import { IntegrityPanel } from "./IntegrityPanel";

interface ThreadCard {
  threadKey: string;
  userEmail: string;
  vendorName: string;
  drill?: boolean;
  phase: string;
  updatedAt: string;
  rounds: number;
  pricePerDay: number | null;
  currency: string | null;
  declined: boolean;
  avgRating: number | null;
  reviewCount: number;
  openFlags: number;
  bookmark: boolean;
  autoReasons: string[];
  judge: { outcomeDelta: number | null; verdict: string | null } | null;
  lastMsg: { dir: string; text: string; at: string } | null;
}

interface InboxRow {
  id: number;
  thread_key: string;
  decision_id: string | null;
  vendor_name: string | null;
  user_email: string | null;
  status: string;
  source: string;
  auto_reason: string | null;
  rating: number | null;
  tags: string[] | null;
  created_at: string;
}

export function OpsCenter() {
  const [tab, setTab] = useState<"inbox" | "threads" | "analytics" | "policy" | "integrity">(
    "inbox"
  );
  const [open, setOpen] = useState<{ threadKey: string; vendorName: string } | null>(null);
  const [detected, setDetected] = useState<number | null>(null);

  // Opportunistic detection sweep (same piggyback pattern as outbox draining):
  // the system pre-fills the inbox with its own weakest conversations.
  useEffect(() => {
    fetch("/api/admin/ops/detect", { method: "POST" })
      .then((r) => r.json())
      .then((d) => setDetected(typeof d?.flagged === "number" ? d.flagged : null))
      .catch(() => {});
  }, []);

  return (
    <div className="space-y-3">
      <div className="surface rounded-blob p-3.5">
        <h2 className="text-[15px] font-extrabold text-strong">🧠 AI Operations Center</h2>
        <p className="mt-0.5 text-[11px] text-soft">
          Every real negotiation, every decision, every reason - review them and the agents
          learn: bookmarks become live exemplars, corrections become training, branch verdicts
          become director priors. Owner-only.
        </p>
        {detected !== null && detected > 0 && (
          <p className="mt-1.5 text-[11px] font-extrabold text-[#8a6100] dark:text-brandyellow">
            🤖 The detector just flagged {detected} conversation{detected === 1 ? "" : "s"} for
            review - they are in the inbox.
          </p>
        )}
      </div>

      {open ? (
        <ConversationPanel
          threadKey={open.threadKey}
          vendorName={open.vendorName}
          onBack={() => setOpen(null)}
        />
      ) : (
        <>
          <div className="surface-strong no-scrollbar flex gap-1 overflow-x-auto rounded-2xl p-1">
            {(
              [
                ["inbox", "📥 Review inbox"],
                ["threads", "💬 All conversations"],
                ["analytics", "📊 Analytics"],
                ["policy", "🗂️ Policy & versions"],
                ["integrity", "🛡️ Block approvals"],
              ] as const
            ).map(([t, label]) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`btn btn-sm shrink-0 rounded-xl px-3 py-2 text-[11px] font-extrabold ${
                  tab === t ? "bg-brandblue text-white" : "text-soft hover:bg-card2"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          {tab === "inbox" && <InboxPanel onOpen={(tk, vn) => setOpen({ threadKey: tk, vendorName: vn })} />}
          {tab === "threads" && (
            <ThreadsPanel onOpen={(tk, vn) => setOpen({ threadKey: tk, vendorName: vn })} />
          )}
          {tab === "analytics" && <AnalyticsPanel />}
          {tab === "policy" && <PolicyPanel />}
          {tab === "integrity" && <IntegrityPanel />}
        </>
      )}
    </div>
  );
}

function InboxPanel({ onOpen }: { onOpen: (threadKey: string, vendorName: string) => void }) {
  const [rows, setRows] = useState<InboxRow[] | null>(null);

  useEffect(() => {
    fetch("/api/admin/ops/review?queue=inbox")
      .then((r) => r.json())
      .then((d) => setRows(Array.isArray(d?.reviews) ? d.reviews : []))
      .catch(() => setRows([]));
  }, []);

  if (rows === null) return <LoadingDots label="Loading the review queue" />;
  if (rows.length === 0) {
    return (
      <div className="surface rounded-blob p-5 text-center">
        <p className="text-[20px]">🎉</p>
        <p className="text-[13px] font-extrabold text-strong">Nothing needs review</p>
        <p className="mx-auto mt-1 max-w-[300px] text-[11px] text-soft">
          Flagged and auto-detected conversations land here. Browse all conversations to review
          proactively - every rating makes the agents sharper.
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {rows.map((r) => (
        <button
          key={r.id}
          onClick={() => onOpen(r.thread_key, r.vendor_name ?? r.thread_key)}
          className="surface lift block w-full rounded-blob p-3 text-left"
        >
          <div className="flex items-center gap-2">
            <span className="min-w-0 truncate text-[13px] font-extrabold text-strong">
              {r.vendor_name ?? r.thread_key.split(":").pop()}
            </span>
            <span
              className={`ml-auto shrink-0 rounded-full px-2 py-0.5 text-[9px] font-extrabold ${
                r.status === "auto_flagged"
                  ? "bg-brandyellow-soft text-[#8a6100] dark:text-brandyellow"
                  : r.status === "flagged"
                    ? "bg-brandred-soft text-brandred"
                    : "bg-brandblue-soft text-brandblue"
              }`}
            >
              {r.status.replace("_", " ")}
            </span>
          </div>
          <p className="truncate text-[10px] text-faint">{r.user_email}</p>
          {r.auto_reason && <p className="mt-1 text-[11px] text-soft">🤖 {r.auto_reason}</p>}
          {(r.tags?.length ?? 0) > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {r.tags!.map((t) => (
                <span key={t} className="rounded-full bg-card2 px-1.5 py-0.5 text-[9px] font-bold text-soft">
                  {t}
                </span>
              ))}
            </div>
          )}
        </button>
      ))}
    </div>
  );
}

function ThreadsPanel({ onOpen }: { onOpen: (threadKey: string, vendorName: string) => void }) {
  const [threads, setThreads] = useState<ThreadCard[] | null>(null);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<"all" | "flagged" | "bookmarked">("all");

  const load = useCallback(() => {
    const params = new URLSearchParams();
    if (q.trim()) params.set("q", q.trim());
    if (filter === "flagged") params.set("flagged", "1");
    if (filter === "bookmarked") params.set("bookmarked", "1");
    fetch(`/api/admin/ops/conversations?${params}`)
      .then((r) => r.json())
      .then((d) => setThreads(Array.isArray(d?.threads) ? d.threads : []))
      .catch(() => setThreads([]));
  }, [q, filter]);

  useEffect(() => {
    const t = setTimeout(load, q ? 350 : 0);
    return () => clearTimeout(t);
  }, [load, q]);

  return (
    <div className="space-y-2">
      <div className="flex gap-1.5">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search shop, user, phase..."
          className="h-10 min-w-0 flex-1 rounded-xl border-2 border-line bg-card px-3 text-[13px] text-strong placeholder:text-faint focus:border-brandblue focus:outline-none"
        />
        {(["all", "flagged", "bookmarked"] as const).map((fk) => (
          <button
            key={fk}
            onClick={() => setFilter(fk)}
            className={`chip shrink-0 rounded-xl border px-2 text-[10px] font-extrabold ${
              filter === fk ? "border-brandblue bg-brandblue-soft text-brandblue" : "border-line text-soft"
            }`}
          >
            {fk === "all" ? "All" : fk === "flagged" ? "🚩" : "🔖"}
          </button>
        ))}
      </div>

      {threads === null && <LoadingDots label="Loading conversations" />}
      {threads?.length === 0 && (
        <div className="surface rounded-blob p-5 text-center">
          <p className="text-[13px] font-extrabold text-strong">No conversations yet</p>
          <p className="mt-1 text-[11px] text-soft">
            Real negotiations appear here the moment agents start messaging shops.
          </p>
        </div>
      )}
      {threads?.map((t) => (
        <button
          key={t.threadKey}
          onClick={() => onOpen(t.threadKey, t.vendorName)}
          className="surface lift block w-full rounded-blob p-3 text-left"
        >
          <div className="flex items-center gap-1.5">
            <span className="min-w-0 truncate text-[13px] font-extrabold text-strong">
              {t.bookmark ? "🔖 " : ""}
              {t.vendorName}
            </span>
            {t.drill && (
              <span className="shrink-0 rounded-full bg-brandyellow-soft px-1.5 py-0.5 text-[9px] font-extrabold text-[#8a6100] dark:text-brandyellow">
                🧪 drill
              </span>
            )}
            {t.openFlags > 0 && (
              <span className="shrink-0 rounded-full bg-brandred-soft px-1.5 py-0.5 text-[9px] font-extrabold text-brandred">
                {t.openFlags} open
              </span>
            )}
            <span className="ml-auto shrink-0 rounded-full bg-card2 px-2 py-0.5 text-[9px] font-extrabold capitalize text-soft">
              {t.declined ? "declined" : t.phase}
            </span>
          </div>
          <p className="truncate text-[10px] text-faint">{t.userEmail}</p>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-soft">
            {t.pricePerDay != null && (
              <span className="font-extrabold text-savings">
                {t.currency ?? ""} {t.pricePerDay}/day
              </span>
            )}
            <span>{t.rounds} round{t.rounds === 1 ? "" : "s"}</span>
            {t.avgRating != null && <span>⭐ {t.avgRating}</span>}
            {t.judge?.outcomeDelta != null && <span>judge {t.judge.outcomeDelta}/5</span>}
            <span className="ml-auto text-faint">{new Date(t.updatedAt).toLocaleDateString()}</span>
          </div>
          {t.autoReasons.length > 0 && (
            <p className="mt-1 truncate text-[10px] text-[#8a6100] dark:text-brandyellow">
              🤖 {t.autoReasons[0]}
            </p>
          )}
          {t.lastMsg && (
            <p className="mt-1 truncate text-[11px] text-soft">
              {t.lastMsg.dir === "in" ? "Shop: " : "Agent: "}
              {t.lastMsg.text}
            </p>
          )}
        </button>
      ))}
    </div>
  );
}
