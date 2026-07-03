"use client";

import { useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/icons";
import { BrandMark } from "@/components/BrandMark";
import { LoadingDots } from "@/components/LoadingDots";
import { LanguageButton } from "@/components/LanguageButton";
import { PlanCard, type PlanView } from "@/components/UpgradeSheet";
import type { AnalyticsSnapshot } from "@/lib/types";

interface KeyInfo {
  name: string;
  label: string;
  configured: boolean;
  masked: string;
  scope: string;
  editable: boolean;
}
interface UserRecord {
  email: string;
  phone?: string;
  status: "active" | "blocked";
  role: "owner" | "admin" | "user";
  plan?: string;
  provider: string;
  addedAt: number;
  lastSeen: number;
}

interface FeedbackRow {
  id: number;
  category: string;
  body: string;
  reporter_email: string | null;
  is_real_issue: boolean;
  severity: string | null;
  summary: string | null;
  triage_reason: string | null;
  image_count: number;
  created_at: string;
}

export default function AdminPage() {
  const [authorized, setAuthorized] = useState<boolean | null>(null);
  const [tab, setTab] = useState<"analytics" | "keys" | "users" | "feedback" | "billing">(
    "analytics"
  );
  const [analytics, setAnalytics] = useState<AnalyticsSnapshot | null>(null);
  const [keys, setKeys] = useState<KeyInfo[]>([]);
  const [users, setUsers] = useState<UserRecord[]>([]);
  const [editing, setEditing] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<string | null>(null);
  const [persistent, setPersistent] = useState(false);
  const [plans, setPlans] = useState<PlanView[]>([]);
  const [stripeOn, setStripeOn] = useState(false);
  const [newAdmin, setNewAdmin] = useState("");
  const [userMsg, setUserMsg] = useState<string | null>(null);
  const [isOwner, setIsOwner] = useState(false);
  const [keyWarning, setKeyWarning] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<{ name: string; label: string; value: string }[] | null>(null);
  const [aiProviders, setAiProviders] = useState<any[]>([]);
  const [training, setTraining] = useState("");
  const [trainingImages, setTrainingImages] = useState<string[]>([]);
  const [trainingCount, setTrainingCount] = useState(0);
  const [trainMsg, setTrainMsg] = useState<string | null>(null);
  const [trainBusy, setTrainBusy] = useState(false);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [userSearch, setUserSearch] = useState("");
  const [userSort, setUserSort] = useState<"new" | "old" | "management">("new");
  const [feedbackRows, setFeedbackRows] = useState<FeedbackRow[]>([]);
  const [diag, setDiag] = useState<{ kind: string; text: string; ok: boolean } | null>(null);
  const [diagBusy, setDiagBusy] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const a = await fetch("/api/admin/analytics");
      if (a.status === 403) {
        setAuthorized(false);
        return;
      }
      setAuthorized(true);
      setAnalytics(await a.json());
      const cfg = await (await fetch("/api/admin/config")).json();
      setKeys(cfg.keys ?? []);
      setPersistent(Boolean(cfg.persistent));
      const u = await (await fetch("/api/admin/users")).json();
      setUsers(u.users ?? []);
      const bill = await (await fetch("/api/billing/checkout")).json();
      setPlans(bill.plans ?? []);
      setStripeOn(Boolean(bill.configured));
      const me = await (await fetch("/api/auth/me")).json();
      setIsOwner(me.session?.role === "owner");
      const ai = await (await fetch("/api/admin/ai-status")).json();
      setAiProviders(ai.providers ?? []);
      const tr = await (await fetch("/api/admin/training")).json();
      setTrainingCount((tr.examples ?? []).length);
      const fb = await (await fetch("/api/admin/feedback")).json();
      setFeedbackRows(fb.feedback ?? []);
    })().catch(() => setAuthorized(false));
  }, []);

  const visibleUsers = useMemo(() => {
    const q = userSearch.trim().toLowerCase();
    let list = users.filter(
      (u) =>
        !q ||
        u.email.toLowerCase().includes(q) ||
        (u.phone ?? "").toLowerCase().includes(q) ||
        u.role.includes(q) ||
        (u.plan ?? "").includes(q)
    );
    if (userSort === "new") list = [...list].sort((a, b) => b.lastSeen - a.lastSeen);
    else if (userSort === "old") list = [...list].sort((a, b) => a.lastSeen - b.lastSeen);
    else
      list = [...list].sort((a, b) => {
        const rank = (u: UserRecord) => (u.role === "owner" ? 0 : u.role === "admin" ? 1 : 2);
        return rank(a) - rank(b) || b.lastSeen - a.lastSeen;
      });
    return list;
  }, [users, userSearch, userSort]);

  async function runDiag(kind: "supabase" | "maps") {
    setDiagBusy(kind);
    setDiag(null);
    try {
      const res = await fetch(kind === "supabase" ? "/api/admin/supabase-test" : "/api/admin/maps-test");
      const d = await res.json();
      if (kind === "supabase") {
        setDiag({ kind, ok: Boolean(d.appConfigOk), text: d.detail ?? "No result." });
      } else {
        const lines = [
          `Places API (New): ${d.placesNew?.ok ? "OK" : "FAILED"} - ${d.placesNew?.detail}`,
          `Places API (legacy): ${d.placesLegacy?.ok ? "OK" : "FAILED"} - ${d.placesLegacy?.detail}`,
          `Geocoding: ${d.geocoding?.ok ? "OK" : "FAILED"} - ${d.geocoding?.detail}`,
        ];
        setDiag({
          kind,
          ok: Boolean(d.placesNew?.ok || d.placesLegacy?.ok),
          text: d.keyConfigured ? lines.join("\n") : "No Google Maps key configured yet.",
        });
      }
    } catch {
      setDiag({ kind, ok: false, text: "Could not run the test." });
    } finally {
      setDiagBusy(null);
    }
  }

  async function saveKey(name: string) {
    const value = editing[name] ?? "";
    setSavingKey(name);
    try {
      const res = await fetch("/api/admin/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, value }),
      });
      const data = await res.json();
      if (data.key) {
        setKeys((ks) => ks.map((k) => (k.name === name ? data.key : k)));
        setEditing((e) => ({ ...e, [name]: "" }));
        setSaved(name);
        setKeyWarning(data.warning ?? null);
        setTimeout(() => setSaved(null), 1500);
      } else if (data.error) {
        setKeyWarning(data.error);
      }
    } finally {
      setSavingKey(null);
    }
  }

  async function toggleReveal() {
    if (revealed) {
      setRevealed(null);
      return;
    }
    const res = await fetch("/api/admin/config?reveal=1");
    const data = await res.json();
    if (data.values) setRevealed(data.values);
  }

  async function switchProvider(provider: string) {
    const res = await fetch("/api/admin/ai-status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider }),
    });
    const data = await res.json();
    if (data.providers) setAiProviders(data.providers);
    if (data.warning) setKeyWarning(data.warning);
  }

  async function teach() {
    setTrainMsg(null);
    setTrainBusy(true);
    try {
      const res = await fetch("/api/admin/training", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: training, images: trainingImages }),
      });
      const data = await res.json();
      if (res.ok) {
        setTraining("");
        setTrainingImages([]);
        setTrainingCount((data.examples ?? []).length);
        setTrainMsg(
          data.transcribed
            ? "Learned ✓ - the agent read your screenshots and learned the conversation."
            : "Learned ✓ - the bargaining agents will use this style."
        );
      } else {
        setTrainMsg(data.error ?? "Could not save.");
      }
    } finally {
      setTrainBusy(false);
    }
  }

  function addTrainingFiles(files: FileList | null) {
    if (!files) return;
    Array.from(files)
      .slice(0, 5 - trainingImages.length)
      .forEach((f) => {
        const reader = new FileReader();
        reader.onload = () =>
          setTrainingImages((prev) => [...prev, String(reader.result)].slice(0, 5));
        reader.readAsDataURL(f);
      });
  }

  async function userAction(body: Record<string, string>) {
    setUserMsg(null);
    const res = await fetch("/api/admin/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.error) setUserMsg(data.error);
    else setUsers(data.users ?? []);
  }

  if (authorized === null) {
    return (
      <Shell>
        <div className="mt-20 text-center text-faint">Checking access...</div>
      </Shell>
    );
  }
  if (!authorized) {
    return (
      <Shell>
        <div className="mt-20 text-center">
          <Icon name="lock" className="mx-auto mb-3 h-10 w-10 text-faint" />
          <p className="text-soft">This workspace is restricted to management.</p>
          <a href="/login" className="mt-3 inline-block font-extrabold text-brandblue underline">
            Sign in with a management email
          </a>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="surface-strong mb-4 flex gap-1 rounded-2xl p-1">
        {(["analytics", "keys", "users", "feedback", "billing"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`btn btn-sm flex-1 rounded-xl py-2 text-[11px] font-extrabold capitalize ${
              tab === t ? "bg-brandblue text-white" : "text-soft hover:bg-card2"
            }`}
          >
            {t}
            {t === "feedback" && feedbackRows.length > 0 ? ` (${feedbackRows.length})` : ""}
          </button>
        ))}
      </div>

      {tab === "analytics" && analytics && (
        <div className="space-y-3">
          {/* Teach the agents from real bargains */}
          <div className="surface rounded-blob p-4">
            <div className="mb-1 text-[13px] font-extrabold text-strong">
              🎓 Teach the bargaining agents
            </div>
            <p className="mb-2 text-[11px] text-faint">
              Paste a real WhatsApp conversation where you bargained with a
              rental shop. The agents learn your tone and moves ({trainingCount}{" "}
              example{trainingCount === 1 ? "" : "s"} learned).
            </p>
            <textarea
              value={training}
              onChange={(e) => setTraining(e.target.value)}
              rows={4}
              placeholder={"Me: Hi! How much for a 125cc scooter for 3 days?\nShop: 100k per day\nMe: I saw 80k nearby, can you do 75k if I take 3 days?\n..."}
              className="w-full resize-none rounded-2xl border-2 border-line bg-card p-3 text-[13px] text-strong placeholder:text-faint focus:border-brandblue focus:outline-none"
            />
            {/* Screenshots of real bargains - the vision agent transcribes them */}
            <div className="mt-2 flex items-center gap-2">
              {trainingImages.map((img, i) => (
                <div key={i} className="relative h-12 w-12 overflow-hidden rounded-lg border-2 border-line">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={img} alt="" className="h-full w-full object-cover" />
                  <button
                    type="button"
                    onClick={() => setTrainingImages((p) => p.filter((_, j) => j !== i))}
                    className="absolute right-0 top-0 flex h-4 w-4 items-center justify-center bg-black/60 text-[10px] text-white"
                  >
                    ✕
                  </button>
                </div>
              ))}
              {trainingImages.length < 5 && (
                <label className="btn flex h-12 w-12 cursor-pointer items-center justify-center rounded-lg border-2 border-dashed border-line text-faint hover:border-brandblue hover:text-brandblue">
                  <input
                    type="file"
                    accept="image/*"
                    multiple
                    className="sr-only"
                    onChange={(e) => {
                      addTrainingFiles(e.target.files);
                      e.target.value = "";
                    }}
                  />
                  <Icon name="plus" className="h-4 w-4" />
                </label>
              )}
              <span className="text-[10px] text-faint">
                Or add chat screenshots - the AI reads real bargain images too.
              </span>
            </div>
            {trainMsg && (
              <p className="mt-1 text-[12px] font-bold text-savings">{trainMsg}</p>
            )}
            <button
              onClick={teach}
              disabled={trainBusy || (training.trim().length < 20 && trainingImages.length === 0)}
              className="btn btn-primary mt-2 w-full rounded-2xl py-2.5 text-[13px] disabled:opacity-60"
            >
              {trainBusy ? <LoadingDots light label="Learning" /> : "Teach the agents"}
            </button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Metric label="Search runs" value={String(analytics.totalRuns)} />
            <Metric label="Offers pulled" value={String(analytics.totalOffers)} />
            <Metric label="Avg discount" value={`${analytics.avgDiscountPct}%`} accent />
            <Metric label="Avg cycle" value={`${analytics.avgCycleSeconds}s`} />
          </div>
          <div className="surface rounded-blob p-4">
            <div className="mb-3 flex items-center gap-1.5 text-sm font-extrabold text-strong">
              <Icon name="spark" className="h-4 w-4 text-brandred" /> Agent memory - negotiation playbook
            </div>
            <p className="mb-3 text-[12px] text-faint">
              Best performer:{" "}
              <span className="font-extrabold text-brandblue">{analytics.bestTactic ?? "-"}</span>
            </p>
            <div className="space-y-2">
              {analytics.tactics.map((t) => {
                const winRate = t.uses ? Math.round((t.wins / t.uses) * 100) : 0;
                return (
                  <div key={t.id} className="rounded-2xl bg-card2 p-3">
                    <div className="flex items-center justify-between">
                      <span className="text-[13px] font-extrabold text-strong">{t.label}</span>
                      <span className="text-[11px] text-faint">
                        {t.wins}/{t.uses} wins · {t.avgDiscountPct}% avg cut
                      </span>
                    </div>
                    <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-line">
                      <div
                        className="h-full rounded-full bg-brandblue transition-all"
                        style={{ width: `${winRate}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {tab === "keys" && (
        <div className="space-y-3">
          <div
            className={`rounded-2xl border-2 p-3 text-[12px] font-bold ${
              persistent
                ? "border-savings bg-savings-soft text-savings"
                : "border-brandyellow bg-brandyellow-soft text-[#8a6100] dark:text-brandyellow"
            }`}
          >
            <Icon name="shield" className="mr-1 inline h-4 w-4" />
            {persistent
              ? "Persistence is on - edits are encrypted, saved to Supabase, applied within ~30s, and survive restarts."
              : "Persistence is OFF: Supabase is not connected, so anything you paste here resets on the next deploy. Set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in Vercel and run schema.sql."}
          </div>

          {keyWarning && (
            <div className="rounded-2xl border-2 border-brandred bg-brandred-soft p-3 text-[12px] font-bold text-brandred">
              {keyWarning}
            </div>
          )}

          {/* One-tap live diagnostics */}
          <div className="surface rounded-blob p-4">
            <div className="text-[13px] font-extrabold text-strong">🩺 Connection tests</div>
            <p className="mb-2 text-[11px] text-faint">
              Fire a real request and get the exact error + fix, instead of guessing.
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => runDiag("supabase")}
                disabled={diagBusy !== null}
                className="btn btn-ghost btn-sm flex-1 rounded-xl text-[12px] disabled:opacity-60"
              >
                {diagBusy === "supabase" ? <LoadingDots label="Testing" /> : "Test Supabase"}
              </button>
              <button
                onClick={() => runDiag("maps")}
                disabled={diagBusy !== null}
                className="btn btn-ghost btn-sm flex-1 rounded-xl text-[12px] disabled:opacity-60"
              >
                {diagBusy === "maps" ? <LoadingDots label="Testing" /> : "Test Google key"}
              </button>
            </div>
            {diag && (
              <pre
                className={`mt-2 whitespace-pre-wrap rounded-xl p-2.5 font-sans text-[11px] font-bold ${
                  diag.ok ? "bg-savings-soft text-savings" : "bg-brandred-soft text-brandred"
                }`}
              >
                {diag.text}
              </pre>
            )}
          </div>

          {/* AI providers: usage, remaining, switch, failover */}
          <div className="surface rounded-blob p-4">
            <div className="mb-1 text-[13px] font-extrabold text-strong">AI providers</div>
            <p className="mb-2 text-[11px] text-faint">
              The starred provider goes first; if it fails or runs out, the next
              one takes over automatically. Tap to switch.
            </p>
            <div className="space-y-2">
              {aiProviders.map((p) => (
                <button
                  key={p.name}
                  onClick={() => switchProvider(p.name)}
                  className={`btn chip w-full rounded-2xl border-2 p-3 text-left ${
                    p.preferred ? "border-brandblue bg-brandblue-soft" : "border-line"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-[13px] font-extrabold capitalize text-strong">
                      {p.preferred ? "★ " : ""}
                      {p.name}
                    </span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-extrabold ${
                        p.configured ? "bg-savings-soft text-savings" : "bg-card2 text-faint"
                      }`}
                    >
                      {p.configured ? "key set" : "no key"}
                    </span>
                  </div>
                  <div className="mt-0.5 text-[11px] text-soft">
                    Used here: {p.tokensUsed.toLocaleString()} tokens · {p.requests} calls
                    {p.failures > 0 ? ` · ${p.failures} failovers` : ""}
                  </div>
                  <div className="text-[11px] text-faint">
                    Remaining:{" "}
                    {p.remaining ?? "this provider does not expose remaining quota"}
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* Owner-only: reveal & copy raw values */}
          {isOwner && (
            <div className="surface rounded-blob p-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-[13px] font-extrabold text-strong">
                    👑 Owner: reveal all keys
                  </div>
                  <p className="text-[11px] text-faint">
                    Visible and copyable only for you. Keep this screen private.
                  </p>
                </div>
                <button onClick={toggleReveal} className="btn btn-sm btn-ghost rounded-xl px-3 text-[12px]">
                  {revealed ? "Hide" : "Reveal"}
                </button>
              </div>
              {revealed && (
                <div className="mt-2 space-y-1.5">
                  {revealed.map((v) => (
                    <div key={v.name} className="flex items-center gap-2 rounded-xl bg-card2 p-2">
                      <div className="min-w-0 flex-1">
                        <div className="text-[10px] font-extrabold text-faint">{v.name}</div>
                        <div className="truncate font-mono text-[11px] text-strong">
                          {v.value || "- not set -"}
                        </div>
                      </div>
                      {v.value && (
                        <button
                          onClick={() => navigator.clipboard?.writeText(v.value)}
                          className="btn btn-sm chip shrink-0 rounded-lg bg-brandblue-soft px-2.5 py-1 text-[11px] font-extrabold text-brandblue"
                        >
                          Copy
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          {keys.map((k) => (
            <div key={k.name} className="surface rounded-blob p-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-[13px] font-extrabold text-strong">{k.label}</div>
                  <div className="font-mono text-[11px] text-faint">{k.name}</div>
                </div>
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] font-extrabold ${
                    k.configured ? "bg-savings-soft text-savings" : "bg-card2 text-faint"
                  }`}
                >
                  {k.configured ? "configured" : "missing"}
                </span>
              </div>
              <div className="mt-2 font-mono text-[12px] text-soft">{k.masked}</div>
              {k.editable ? (
                <div className="mt-2 flex gap-2">
                  <input
                    type="password"
                    placeholder="Set / rotate value"
                    value={editing[k.name] ?? ""}
                    onChange={(e) => setEditing((ed) => ({ ...ed, [k.name]: e.target.value }))}
                    className="flex-1 rounded-xl border-2 border-line bg-card p-2 text-[12px] text-strong focus:border-brandblue focus:outline-none"
                  />
                  <button
                    onClick={() => saveKey(k.name)}
                    disabled={savingKey === k.name}
                    className="btn btn-primary btn-sm rounded-xl px-3 text-[12px] disabled:opacity-60"
                  >
                    {savingKey === k.name ? (
                      <LoadingDots light />
                    ) : saved === k.name ? (
                      "Saved"
                    ) : (
                      "Apply"
                    )}
                  </button>
                </div>
              ) : (
                <div className="mt-2 text-[11px] text-faint">
                  Bootstrap secret - set via host environment variables only.
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {tab === "users" && (
        <div className="space-y-3">
          {/* Add management */}
          <div className="surface rounded-blob p-4">
            <div className="mb-2 text-[13px] font-extrabold text-strong">
              Add management user
            </div>
            <div className="flex gap-2">
              <input
                type="email"
                value={newAdmin}
                onChange={(e) => setNewAdmin(e.target.value)}
                placeholder="colleague@email.com"
                className="flex-1 rounded-xl border-2 border-line bg-card p-2.5 text-[13px] text-strong placeholder:text-faint focus:border-brandblue focus:outline-none"
              />
              <button
                onClick={() => {
                  if (newAdmin.trim()) {
                    userAction({ email: newAdmin.trim(), action: "promote" });
                    setNewAdmin("");
                  }
                }}
                className="btn btn-primary btn-sm rounded-xl px-4 text-[12px]"
              >
                Promote
              </button>
            </div>
            <p className="mt-1.5 text-[11px] text-faint">
              Only management can add management. The owner can never be demoted.
            </p>
          </div>

          {userMsg && (
            <div className="rounded-2xl bg-brandred-soft p-2.5 text-[12px] font-bold text-brandred">
              {userMsg}
            </div>
          )}

          {/* Search + sort */}
          <div className="flex gap-2">
            <input
              value={userSearch}
              onChange={(e) => setUserSearch(e.target.value)}
              placeholder="Search email, phone, role..."
              className="flex-1 rounded-xl border-2 border-line bg-card p-2.5 text-[13px] text-strong placeholder:text-faint focus:border-brandblue focus:outline-none"
            />
            <select
              value={userSort}
              onChange={(e) => setUserSort(e.target.value as typeof userSort)}
              className="rounded-xl border-2 border-line bg-card p-2.5 text-[12px] font-bold text-strong"
            >
              <option value="new">Newest first</option>
              <option value="old">Oldest first</option>
              <option value="management">Management first</option>
            </select>
          </div>

          {users.length === 0 && (
            <div className="surface rounded-blob p-4 text-center text-[12px] text-faint">
              No registered users found. If someone signed up but is missing
              here, Supabase is not connected - run Test Supabase in Keys.
            </div>
          )}
          {visibleUsers.length === 0 && users.length > 0 && (
            <div className="surface rounded-blob p-4 text-center text-[12px] text-faint">
              No users match &quot;{userSearch}&quot;.
            </div>
          )}
          {visibleUsers.map((u) => (
            <div key={u.email} className="surface rounded-blob p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[13px] font-extrabold text-strong">
                      {u.email}
                    </span>
                    <span
                      className={`shrink-0 rounded-full px-2 py-0.5 text-[9px] font-extrabold ${
                        u.role === "owner"
                          ? "bg-brandyellow text-[#4a3300]"
                          : u.role === "admin"
                          ? "bg-brandblue text-white"
                          : "bg-card2 text-faint"
                      }`}
                    >
                      {u.role.toUpperCase()}
                    </span>
                    {u.plan && u.role === "user" && u.plan !== "free" && (
                      <span
                        className={`shrink-0 rounded-full px-2 py-0.5 text-[9px] font-extrabold text-white ${
                          u.plan === "ultra" || u.plan === "business" ? "badge-ultra" : "bg-brandblue"
                        }`}
                      >
                        {(u.plan === "business" ? "ultra" : u.plan).toUpperCase()}
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] text-faint">
                    {u.phone ?? "no phone"} · {u.provider} · seen{" "}
                    {new Date(u.lastSeen).toLocaleString()}
                  </div>
                </div>
              </div>
              {u.role !== "owner" && (
                <div className="mt-2 flex gap-2">
                  <button
                    onClick={() =>
                      userAction({
                        email: u.email,
                        action: u.role === "admin" ? "demote" : "promote",
                      })
                    }
                    className="btn btn-sm chip flex-1 rounded-xl bg-brandblue-soft py-1.5 text-[12px] font-extrabold text-brandblue"
                  >
                    {u.role === "admin" ? "Remove admin" : "Make admin"}
                  </button>
                  <button
                    onClick={() =>
                      userAction({
                        email: u.email,
                        status: u.status === "active" ? "blocked" : "active",
                      })
                    }
                    className={`btn btn-sm chip flex-1 rounded-xl py-1.5 text-[12px] font-extrabold ${
                      u.status === "active"
                        ? "bg-brandred-soft text-brandred"
                        : "bg-savings-soft text-savings"
                    }`}
                  >
                    {u.status === "active" ? "Block" : "Unblock"}
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {tab === "feedback" && (
        <div className="space-y-3">
          <div className="rounded-2xl border-2 border-savings bg-savings-soft p-3 text-[12px] font-bold text-savings">
            📥 The in-app feedback inbox works with ZERO setup - every triaged
            report lands here from Supabase. Email delivery (Resend) is
            optional on top.
          </div>
          {feedbackRows.length === 0 && (
            <div className="surface rounded-blob p-4 text-center text-[12px] text-faint">
              No feedback yet (or Supabase is not connected - run Test Supabase
              in Keys).
            </div>
          )}
          {feedbackRows.map((f) => (
            <div key={f.id} className="surface rounded-blob p-3">
              <div className="flex items-center gap-2">
                <span
                  className={`rounded-full px-2 py-0.5 text-[9px] font-extrabold ${
                    f.is_real_issue
                      ? f.severity === "high"
                        ? "bg-brandred text-white"
                        : "bg-brandyellow text-[#4a3300]"
                      : "bg-card2 text-faint"
                  }`}
                >
                  {f.is_real_issue ? (f.severity ?? "issue").toUpperCase() : "NOISE"}
                </span>
                <span className="text-[11px] font-bold capitalize text-soft">{f.category}</span>
                <span className="ml-auto text-[10px] text-faint">
                  {new Date(f.created_at).toLocaleString()}
                </span>
              </div>
              <div className="mt-1 text-[13px] font-extrabold text-strong">
                {f.summary || f.body.slice(0, 80)}
              </div>
              <p className="mt-0.5 whitespace-pre-wrap text-[12px] text-soft">{f.body}</p>
              <div className="mt-1 text-[10px] text-faint">
                {f.reporter_email ?? "anonymous"}
                {f.image_count > 0 ? ` · ${f.image_count} screenshot(s)` : ""}
                {f.triage_reason ? ` · ${f.triage_reason}` : ""}
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === "billing" && (
        <div className="space-y-3">
          <div
            className={`rounded-2xl border-2 p-3 text-[12px] font-bold ${
              stripeOn
                ? "border-savings bg-savings-soft text-savings"
                : "border-brandyellow bg-brandyellow-soft text-[#8a6100] dark:text-brandyellow"
            }`}
          >
            <Icon name="card" className="mr-1 inline h-4 w-4" />
            {stripeOn
              ? "Payments are connected. Users see the 80% launch offer (billed every 3 months) via the upgrade chip and at signup."
              : "Billing preview. Recommended for Israel: connect Lemon Squeezy (no business entity needed, pays out via PayPal/wire) - add the LEMONSQUEEZY_* keys in the Keys tab. Stripe stays available as an alternative."}
          </div>
          {plans.map((p) => (
            <PlanCard key={p.id} plan={p} />
          ))}
        </div>
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto min-h-[100dvh] max-w-md pb-16 sm:max-w-lg md:max-w-2xl">
      <div className="topbar">
        <div className="mx-auto flex max-w-md items-center justify-between px-4 pb-2.5 sm:max-w-lg md:max-w-2xl">
          <div className="flex items-center gap-2">
            <BrandMark size={30} />
            <div>
              <h1 className="font-display text-lg font-extrabold leading-none text-strong">
                Management
              </h1>
              <p className="text-[10px] font-bold text-faint">WheelDeal workspace</p>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <LanguageButton />
            <a href="/" className="btn btn-sm btn-ghost rounded-xl px-3 py-1.5 text-[12px]">
              ← App
            </a>
          </div>
        </div>
      </div>
      <div className="px-4 pt-4">{children}</div>
    </main>
  );
}

function Metric({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div className="surface rounded-blob p-4 text-center">
      <div className="text-[10px] font-extrabold uppercase tracking-wide text-faint">{label}</div>
      <div className={`mt-1 text-xl font-extrabold ${accent ? "text-brandblue" : "text-strong"}`}>
        {value}
      </div>
    </div>
  );
}
