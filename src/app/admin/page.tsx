"use client";

import { useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/icons";
import { BrandMark } from "@/components/BrandMark";
import { LoadingDots } from "@/components/LoadingDots";
import { SkeletonList } from "@/components/Skeleton";
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
  docUrl?: string;
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
  images?: string[];
  status?: string;
  owner_note?: string | null;
  created_at: string;
}

export default function AdminPage() {
  const [authorized, setAuthorized] = useState<boolean | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [tab, setTab] = useState<
    "command" | "analytics" | "agents" | "intel" | "keys" | "users" | "feedback" | "billing" | "data"
  >("command");
  const [intel, setIntel] = useState<{
    areas: {
      area: string;
      vehicles: {
        vehicle: string; currency: string; samples: number; shops: number;
        low: number; high: number; avg: number; typicalDays: number | null;
        deliverRate: number; lastSeen: string;
      }[];
    }[];
    totalOffers: number;
  } | null>(null);
  async function loadIntel() {
    const r = await (await fetch("/api/admin/intelligence")).json();
    if (r.areas) setIntel(r);
  }
  // Command center + agent studio data
  const [command, setCommand] = useState<{
    alerts: { level: string; title: string; detail: string; href?: string }[];
    stats: Record<string, number>;
  } | null>(null);
  const [floors, setFloors] = useState<
    { id: number; region_key: string; vehicle_key: string; currency: string; floor_per_day: number; typical_per_day: number | null; source: string }[]
  >([]);
  const [floorRegion, setFloorRegion] = useState("");
  const [floorBusy, setFloorBusy] = useState(false);
  const [floorMsg, setFloorMsg] = useState<string | null>(null);
  const [waSec, setWaSec] = useState<{
    policies: Record<string, number | boolean>;
    help: Record<string, { label: string; help: string; best: string }>;
    reputation: {
      sender_key: string;
      trust_score: number;
      risk_score?: number;
      sent_total: number;
      replies_total: number;
      blocks_total?: number;
      fails_total?: number;
      paused_until?: string | null;
      risk?: { score: number; reasons: string[] };
    }[];
    outbox: { id: number; to_number: string; not_before: string }[];
  } | null>(null);
  const [waHelp, setWaHelp] = useState<string | null>(null); // open info popup key
  const [sponsors, setSponsors] = useState<
    { id: number; name: string; phone: string | null; active: boolean; notes: string | null }[]
  >([]);
  const [spName, setSpName] = useState("");
  const [spPhone, setSpPhone] = useState("");
  const [spNotes, setSpNotes] = useState("");
  const [prompts, setPrompts] = useState<
    { id: string; label: string; agent: string; def: string; override: string | null }[]
  >([]);
  const [promptDraft, setPromptDraft] = useState<Record<string, string>>({});
  const [promptSaved, setPromptSaved] = useState<string | null>(null);
  const [xPosts, setXPosts] = useState<
    { text: string; hashtags: string[]; imageIdea: string; angle: string }[]
  >([]);
  const [xTheme, setXTheme] = useState("");
  const [xBusy, setXBusy] = useState(false);
  const [xCopied, setXCopied] = useState<number | null>(null);
  const [xErr, setXErr] = useState<string | null>(null);

  async function genXPosts() {
    setXBusy(true);
    setXErr(null);
    try {
      const r = await (
        await fetch("/api/admin/x-posts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ theme: xTheme }),
        })
      ).json();
      if (r.posts) setXPosts(r.posts);
      else setXErr(r.error ?? "Could not generate posts.");
    } finally {
      setXBusy(false);
    }
  }

  async function loadCommand() {
    const r = await (await fetch("/api/admin/command")).json();
    if (r.alerts) setCommand(r);
  }
  async function loadAgentStudio() {
    const [m, s, sp, pr] = await Promise.all([
      (await fetch("/api/admin/market")).json(),
      (await fetch("/api/admin/wa-security")).json(),
      (await fetch("/api/admin/sponsored")).json(),
      (await fetch("/api/admin/prompts")).json(),
    ]);
    if (m.rows) setFloors(m.rows);
    if (s.policies) setWaSec(s);
    if (sp.rows) setSponsors(sp.rows);
    if (pr.prompts) setPrompts(pr.prompts);
  }
  const [dataTables, setDataTables] = useState<{ name: string; label: string; count: number }[]>([]);
  const [dataTable, setDataTable] = useState<string | null>(null);
  const [dataRows, setDataRows] = useState<Record<string, unknown>[]>([]);
  const [dataBusy, setDataBusy] = useState(false);

  async function loadDataTables() {
    const r = await (await fetch("/api/admin/data")).json();
    setDataTables(r.tables ?? []);
  }
  async function openDataTable(name: string) {
    setDataTable(name);
    setDataBusy(true);
    try {
      const r = await (await fetch(`/api/admin/data?table=${encodeURIComponent(name)}&limit=100`)).json();
      setDataRows(r.rows ?? []);
    } finally {
      setDataBusy(false);
    }
  }
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
  const [trainingCount, setTrainingCount] = useState(0);
  const [trainMsg, setTrainMsg] = useState<string | null>(null);
  const [trainBusy, setTrainBusy] = useState(false);
  const [trainNumbers, setTrainNumbers] = useState("");
  const [memory, setMemory] = useState<{ id: number; text: string; note?: string; origin?: string; source?: string; addedBy?: string; addedAt: number }[]>([]);
  const [memEditId, setMemEditId] = useState<number | null>(null);
  const [memEditText, setMemEditText] = useState("");
  const [memAdd, setMemAdd] = useState("");
  const [memBusy, setMemBusy] = useState(false);

  async function refreshMemory() {
    const tr = await (await fetch("/api/admin/training")).json();
    setMemory(tr.examples ?? []);
    setTrainingCount((tr.examples ?? []).length);
  }
  async function addMemory() {
    if (memAdd.trim().length < 20) {
      setTrainMsg("Paste at least a few lines of a real bargain.");
      return;
    }
    setMemBusy(true);
    try {
      const r = await (await fetch("/api/admin/training", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: memAdd.trim(), note: "manual" }),
      })).json();
      if (r.examples) {
        setMemory(r.examples);
        setTrainingCount(r.examples.length);
        setMemAdd("");
        setTrainMsg("Added to the agents' memory.");
      } else setTrainMsg(r.error ?? "Could not add.");
    } finally {
      setMemBusy(false);
    }
  }
  async function saveMemoryEdit(id: number) {
    setMemBusy(true);
    try {
      const r = await (await fetch("/api/admin/training", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, text: memEditText }),
      })).json();
      if (r.examples) setMemory(r.examples);
      setMemEditId(null);
    } finally {
      setMemBusy(false);
    }
  }
  async function deleteMemory(id: number) {
    const r = await (await fetch(`/api/admin/training?id=${id}`, { method: "DELETE" })).json();
    if (r.examples) {
      setMemory(r.examples);
      setTrainingCount(r.examples.length);
    }
  }
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [userSearch, setUserSearch] = useState("");
  const [userSort, setUserSort] = useState<"new" | "old" | "management">("new");
  const [feedbackRows, setFeedbackRows] = useState<FeedbackRow[]>([]);
  const [feedbackFilter, setFeedbackFilter] = useState<"all" | "high" | "issues" | "noise">("all");
  const [diag, setDiag] = useState<{ kind: string; text: string; ok: boolean } | null>(null);
  const [diagBusy, setDiagBusy] = useState<string | null>(null);
  const [costs, setCosts] = useState<any>(null);
  const [limitEdit, setLimitEdit] = useState<Record<string, string>>({});
  const [limitsBusy, setLimitsBusy] = useState(false);
  const [keyTests, setKeyTests] = useState<Record<string, { ok: boolean; detail: string }>>({});
  const [keyTestBusy, setKeyTestBusy] = useState<string | null>(null);
  const [waHosts, setWaHosts] = useState<
    { hosts: { url: string; healthy: boolean; users: number; detail: string }[]; healthy: number; total: number; users: number } | null
  >(null);
  const [waHostsBusy, setWaHostsBusy] = useState(false);
  const [waHostTest, setWaHostTest] = useState<
    Record<string, { busy: boolean; ok?: boolean; detail?: string }>
  >({});

  async function loadWaHosts() {
    setWaHostsBusy(true);
    try {
      const r = await (await fetch("/api/admin/wa-hosts")).json();
      setWaHosts(r);
    } catch {
      setWaHosts(null);
    } finally {
      setWaHostsBusy(false);
    }
  }

  async function testOneWaHost(url: string) {
    setWaHostTest((p) => ({ ...p, [url]: { busy: true } }));
    try {
      const r = await (await fetch(`/api/admin/wa-hosts?test=${encodeURIComponent(url)}`)).json();
      setWaHostTest((p) => ({ ...p, [url]: { busy: false, ok: r.healthy, detail: r.detail } }));
    } catch {
      setWaHostTest((p) => ({ ...p, [url]: { busy: false, ok: false, detail: "Test failed to run." } }));
    }
  }

  async function refreshCosts() {
    const c = await (await fetch("/api/admin/costs")).json();
    setCosts(c);
    setLimitEdit(
      Object.fromEntries(Object.entries(c.limits ?? {}).map(([k, v]) => [k, String(v)]))
    );
  }

  async function testKey(name: string) {
    setKeyTestBusy(name);
    try {
      const r = await (await fetch(`/api/admin/key-test?name=${encodeURIComponent(name)}`)).json();
      setKeyTests((p) => ({ ...p, [name]: r }));
    } finally {
      setKeyTestBusy(null);
    }
  }

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
      setMemory(tr.examples ?? []);
      const fb = await (await fetch("/api/admin/feedback")).json();
      setFeedbackRows(fb.feedback ?? []);
      await refreshCosts();
      setLoaded(true);
    })().catch(() => setAuthorized(false));
  }, []);

  // Auto-probe the WhatsApp host pool the first time the owner opens Keys.
  useEffect(() => {
    if (tab === "keys" && waHosts === null && !waHostsBusy) loadWaHosts();
    if (tab === "data" && dataTables.length === 0) loadDataTables();
    if (tab === "command" && !command) loadCommand().catch(() => {});
    if (tab === "agents" && floors.length === 0 && !waSec) loadAgentStudio().catch(() => {});
    if (tab === "intel" && !intel) loadIntel().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

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

  async function importTraining() {
    setTrainMsg(null);
    setTrainBusy(true);
    try {
      const res = await fetch("/api/admin/training/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ numbers: trainNumbers }),
      });
      const data = await res.json();
      if (res.ok) {
        setTrainMsg(data.note ?? "Done.");
        await refreshMemory();
      } else {
        setTrainMsg(data.error ?? "Could not import.");
      }
    } catch {
      setTrainMsg("Could not reach the WhatsApp connector.");
    } finally {
      setTrainBusy(false);
    }
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
        <div className="surface-strong mb-4 flex gap-1 rounded-2xl p-1">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="skeleton h-8 flex-1 rounded-xl" />
          ))}
        </div>
        <SkeletonList count={4} />
        <p className="mt-4 text-center text-[12px] font-bold text-faint">
          <LoadingDots label="Checking access" />
        </p>
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
      <div className="surface-strong no-scrollbar mb-4 flex gap-1 overflow-x-auto rounded-2xl p-1">
        {(["command", "analytics", "agents", "intel", "keys", "users", "feedback", "billing", "data"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`btn btn-sm shrink-0 rounded-xl px-3 py-2 text-[11px] font-extrabold capitalize ${
              tab === t ? "bg-brandblue text-white" : "text-soft hover:bg-card2"
            }`}
          >
            {t === "command" ? "🎯 command" : t === "agents" ? "🤖 agents" : t === "intel" ? "📊 intel" : t}
            {t === "feedback" && feedbackRows.length > 0 ? ` (${feedbackRows.length})` : ""}
            {t === "command" && (command?.alerts.filter((a) => a.level === "critical").length ?? 0) > 0
              ? ` (${command!.alerts.filter((a) => a.level === "critical").length}!)`
              : ""}
          </button>
        ))}
      </div>

      {!loaded && <SkeletonList count={4} />}

      {loaded && tab === "command" && (
        <div className="space-y-3">
          {/* Live pulse */}
          {command ? (
            <>
              <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
                {[
                  { k: "waSessions", label: "WA sessions live", emoji: "🟢" },
                  { k: "repliesToday", label: "Shop replies (24h)", emoji: "📥" },
                  { k: "offersToday", label: "Offers landed (24h)", emoji: "🤝" },
                  { k: "queuedMessages", label: "Queued messages", emoji: "🕘" },
                  { k: "openIssues", label: "Open issues", emoji: "🐛" },
                ].map((s) => (
                  <div key={s.k} className="surface rounded-2xl p-3 text-center">
                    <div className="text-xl font-extrabold text-strong">
                      {s.emoji} {command.stats[s.k] ?? 0}
                    </div>
                    <div className="text-[10px] font-bold text-faint">{s.label}</div>
                  </div>
                ))}
              </div>

              {/* Needs your attention NOW */}
              <div className="surface rounded-blob p-4">
                <div className="mb-2 text-[13px] font-extrabold text-strong">
                  🎯 Needs your attention
                </div>
                {command.alerts.length === 0 ? (
                  <p className="rounded-xl bg-savings-soft p-3 text-center text-[12px] font-extrabold text-savings">
                    ✓ All clear - nothing needs you right now.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {command.alerts.map((a, i) => (
                      <button
                        key={i}
                        onClick={() => a.href && setTab(a.href as typeof tab)}
                        className={`block w-full rounded-xl border-2 p-2.5 text-left ${
                          a.level === "critical"
                            ? "border-brandred/40 bg-brandred-soft"
                            : a.level === "warning"
                            ? "border-brandyellow/40 bg-brandyellow-soft"
                            : "border-line bg-card2"
                        }`}
                      >
                        <div
                          className={`text-[12px] font-extrabold ${
                            a.level === "critical"
                              ? "text-brandred"
                              : a.level === "warning"
                              ? "text-[#8a6100] dark:text-brandyellow"
                              : "text-strong"
                          }`}
                        >
                          {a.level === "critical" ? "🚨" : a.level === "warning" ? "⚠️" : "ℹ️"}{" "}
                          {a.title}
                        </div>
                        <div className="mt-0.5 text-[11px] text-soft">{a.detail}</div>
                      </button>
                    ))}
                  </div>
                )}
                <button
                  onClick={() => loadCommand()}
                  className="btn btn-ghost btn-sm mt-2 w-full rounded-xl border-2 border-line text-[11px] font-extrabold text-brandblue"
                >
                  ↻ Refresh
                </button>
              </div>

              {/* X (Twitter) post studio - top model drafts 5 on-trend posts */}
              <div className="surface rounded-blob p-4">
                <div className="mb-1 flex items-center gap-1.5 text-[13px] font-extrabold text-strong">
                  𝕏 Post studio
                  <span className="badge-flash rounded-full px-2 py-0.5 text-[9px] font-extrabold">
                    Top model
                  </span>
                </div>
                <p className="mb-2 text-[11px] text-faint">
                  Our best AI drafts 5 ready-to-post X ideas in WheelDeal&apos;s playful-pro
                  voice - on-trend hooks, emojis, hashtags and a funny image idea. Leave
                  the box empty for fresh trending ideas, or steer it with a theme.
                </p>
                <div className="mb-2 flex gap-2">
                  <input
                    value={xTheme}
                    onChange={(e) => setXTheme(e.target.value)}
                    placeholder="Optional theme, e.g. Songkran in Thailand, scooter myths..."
                    className="flex-1 rounded-xl border-2 border-line bg-card p-2 text-[12px] text-strong focus:border-brandblue focus:outline-none"
                  />
                  <button
                    onClick={genXPosts}
                    disabled={xBusy}
                    className="btn btn-primary btn-sm rounded-xl px-3 text-[12px] disabled:opacity-60"
                  >
                    {xBusy ? <LoadingDots light /> : xPosts.length ? "↻ New 5" : "✨ Draft 5"}
                  </button>
                </div>
                {xErr && <p className="mb-1 text-[11px] font-bold text-brandred">{xErr}</p>}
                <div className="space-y-2">
                  {xPosts.map((p, i) => (
                    <div key={i} className="rounded-xl border-2 border-line p-2.5">
                      <div className="mb-1 flex items-center justify-between">
                        <span className="rounded-full bg-brandblue-soft px-2 py-0.5 text-[9px] font-extrabold uppercase text-brandblue">
                          {p.angle || `Option ${i + 1}`}
                        </span>
                        <button
                          onClick={() => {
                            const full = `${p.text}\n\n${p.hashtags.map((h) => (h.startsWith("#") ? h : `#${h}`)).join(" ")}`;
                            navigator.clipboard?.writeText(full);
                            setXCopied(i);
                            setTimeout(() => setXCopied(null), 1500);
                          }}
                          className="btn btn-sm chip rounded-lg border-2 border-line px-2 text-[10px] font-extrabold text-brandblue"
                        >
                          {xCopied === i ? "Copied ✓" : "Copy"}
                        </button>
                      </div>
                      <p className="whitespace-pre-wrap text-[12px] text-strong">{p.text}</p>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {p.hashtags.map((h) => (
                          <span key={h} className="text-[10px] font-bold text-brandblue">
                            {h.startsWith("#") ? h : `#${h}`}
                          </span>
                        ))}
                      </div>
                      {p.imageIdea && (
                        <div className="mt-1 text-[10px] text-faint">📸 {p.imageIdea}</div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </>
          ) : (
            <SkeletonList count={3} />
          )}
        </div>
      )}

      {loaded && tab === "agents" && (
        <div className="space-y-3">
          {/* Teach the agents automatically from your OWN WhatsApp chats */}
          <div className="surface rounded-blob p-4">
            <div className="mb-1 flex items-center gap-1.5 text-[13px] font-extrabold text-strong">
              🎓 Teach the bargaining agents
              <span className="badge-flash rounded-full px-2 py-0.5 text-[9px] font-extrabold">
                Auto
              </span>
            </div>
            <p className="mb-2 text-[11px] text-faint">
              Connect your WhatsApp (Profile), paste the rental shops&apos; numbers you
              have haggled with, and tap Import. WheelDeal opens ONLY those chats,
              cleans the negotiations, and teaches the agents your exact style - zero
              typing. ({trainingCount} example{trainingCount === 1 ? "" : "s"} learned)
            </p>
            <textarea
              rows={3}
              value={trainNumbers}
              onChange={(e) => setTrainNumbers(e.target.value)}
              placeholder={"Rental shop numbers, one per line:\n+62 812 3456 7890\n+66 98 765 4321"}
              className="mb-2 w-full rounded-xl border-2 border-line bg-card p-2 font-mono text-[12px] text-strong focus:border-brandblue focus:outline-none"
            />
            {trainMsg && (
              <p className="mb-1 text-[12px] font-bold text-savings">{trainMsg}</p>
            )}
            <button
              onClick={importTraining}
              disabled={trainBusy}
              className="btn btn-primary w-full rounded-2xl py-2.5 text-[13px] disabled:opacity-60"
            >
              {trainBusy ? (
                <LoadingDots light label="Reading those shop chats" />
              ) : trainNumbers.trim() ? (
                "💬 Learn from these shop chats"
              ) : (
                "💬 Import bargains from my WhatsApp"
              )}
            </button>
            <p className="mt-1.5 text-[10px] text-faint">
              Private: only the numbers you paste are opened. Leave it empty to let
              the AI scan recent 1:1 chats instead. Personal chats are never stored.
            </p>
          </div>

          {/* Agent memory: full control over everything the agents have learned */}
          <div className="surface rounded-blob p-4">
            <div className="mb-1 flex items-center justify-between">
              <div className="text-[13px] font-extrabold text-strong">🧠 Agent memory</div>
              <span className="rounded-full bg-brandblue-soft px-2 py-0.5 text-[10px] font-extrabold text-brandblue">
                {memory.length} learned
              </span>
            </div>
            <p className="mb-2 text-[11px] text-faint">
              Everything your agents remember and bargain from. You are in full
              control - read, edit, or delete any memory, or add one by hand.
            </p>

            {/* Manual add */}
            <textarea
              rows={3}
              value={memAdd}
              onChange={(e) => setMemAdd(e.target.value)}
              placeholder={"Add a bargain by hand, e.g.\nMe: What is your best price per day for the scooter?\nShop: 150k.\nMe: I will take it at 110k for 3 days.\nShop: Ok 120k, deal."}
              className="mb-2 w-full rounded-xl border-2 border-line bg-card p-2 text-[12px] text-strong focus:border-brandblue focus:outline-none"
            />
            <button
              onClick={addMemory}
              disabled={memBusy}
              className="btn btn-ghost btn-sm mb-3 w-full rounded-xl border-2 border-line text-[12px] font-extrabold text-brandblue disabled:opacity-60"
            >
              {memBusy ? <LoadingDots label="Saving" /> : "+ Add to memory"}
            </button>

            {/* List */}
            {memory.length === 0 ? (
              <p className="rounded-xl bg-card2 p-3 text-center text-[11px] font-bold text-faint">
                No memories yet. Import from WhatsApp above, or add one by hand.
              </p>
            ) : (
              <div className="space-y-2">
                {memory.map((m) => (
                  <div key={m.id} className="rounded-xl border-2 border-line p-2.5">
                    {memEditId === m.id ? (
                      <>
                        <textarea
                          rows={5}
                          value={memEditText}
                          onChange={(e) => setMemEditText(e.target.value)}
                          className="w-full rounded-lg border-2 border-brandblue bg-card p-2 text-[12px] text-strong focus:outline-none"
                        />
                        <div className="mt-1.5 flex gap-2">
                          <button
                            onClick={() => saveMemoryEdit(m.id)}
                            disabled={memBusy}
                            className="btn btn-primary btn-sm flex-1 rounded-lg text-[11px]"
                          >
                            {memBusy ? <LoadingDots light /> : "Save"}
                          </button>
                          <button
                            onClick={() => setMemEditId(null)}
                            className="btn btn-ghost btn-sm flex-1 rounded-lg border-2 border-line text-[11px]"
                          >
                            Cancel
                          </button>
                        </div>
                      </>
                    ) : (
                      <>
                        {/* Origin tracing: where this memory was learned from */}
                        <div className="mb-1 flex items-center gap-1">
                          <span className="rounded-full bg-brandblue-soft px-1.5 py-0.5 text-[9px] font-extrabold text-brandblue">
                            🧬 {m.origin ?? m.note ?? "origin unknown"}
                          </span>
                        </div>
                        <pre className="max-h-28 overflow-y-auto whitespace-pre-wrap font-sans text-[11px] leading-relaxed text-soft">
                          {m.text}
                        </pre>
                        <div className="mt-1.5 flex gap-2">
                          <button
                            onClick={() => {
                              setMemEditId(m.id);
                              setMemEditText(m.text);
                            }}
                            className="btn btn-ghost btn-sm rounded-lg border-2 border-line px-3 text-[11px] font-extrabold text-brandblue"
                          >
                            ✎ Edit
                          </button>
                          <button
                            onClick={() => deleteMemory(m.id)}
                            className="btn btn-ghost btn-sm rounded-lg border-2 border-line px-3 text-[11px] font-extrabold text-brandred"
                          >
                            🗑 Delete
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Market floor prices: the table the agent anchors its ONE ask to */}
          <div className="surface rounded-blob p-4">
            <div className="mb-1 flex items-center justify-between">
              <div className="text-[13px] font-extrabold text-strong">
                📉 Cheapest-price table (market floors)
              </div>
              <span className="rounded-full bg-brandblue-soft px-2 py-0.5 text-[10px] font-extrabold text-brandblue">
                {floors.length} rows
              </span>
            </div>
            <p className="mb-2 text-[11px] text-faint">
              The lowest realistic daily price per area and vehicle bucket. The AI
              researches each area weekly (first search triggers it); your manual
              edits always win. The bargaining agent never asks below these floors.
            </p>
            <div className="mb-2 flex gap-2">
              <input
                value={floorRegion}
                onChange={(e) => setFloorRegion(e.target.value)}
                placeholder="Research an area now, e.g. koh samui, thailand"
                className="flex-1 rounded-xl border-2 border-line bg-card p-2 text-[12px] text-strong focus:border-brandblue focus:outline-none"
              />
              <button
                onClick={async () => {
                  if (!floorRegion.trim()) return;
                  setFloorBusy(true);
                  setFloorMsg(null);
                  try {
                    const r = await (
                      await fetch("/api/admin/market", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ region: floorRegion }),
                      })
                    ).json();
                    setFloorMsg(r.note ?? r.error ?? null);
                    const m = await (await fetch("/api/admin/market")).json();
                    if (m.rows) setFloors(m.rows);
                  } finally {
                    setFloorBusy(false);
                  }
                }}
                disabled={floorBusy}
                className="btn btn-primary btn-sm rounded-xl px-3 text-[11px] disabled:opacity-60"
              >
                {floorBusy ? <LoadingDots light /> : "🔍 Research"}
              </button>
            </div>
            {floorMsg && <p className="mb-2 text-[11px] font-bold text-savings">{floorMsg}</p>}
            <div className="mb-2 rounded-xl bg-card2 p-2 text-[10px] leading-relaxed text-faint">
              🤖 <b>Autonomous:</b> a new area is researched and saved the first
              time a user searches there (or when you research it above), then
              refreshed weekly. We store ONE row per area + vehicle bucket - never
              per town - so the database stays small. Prices are always in the
              area&apos;s <b>local currency</b>. 👑 = your manual edit (survives AI
              refreshes), 🤖 = AI estimate.
            </div>
            {floors.length === 0 ? (
              <p className="rounded-xl bg-card2 p-3 text-center text-[11px] font-bold text-faint">
                No areas researched yet - it happens automatically on the first search
                in an area, or run one above.
              </p>
            ) : (
              (() => {
                // 2-D matrix: one block per AREA, rows = vehicle bucket,
                // columns = floor / typical, in that area's local currency.
                const byArea = new Map<string, typeof floors>();
                for (const f of floors) {
                  if (!byArea.has(f.region_key)) byArea.set(f.region_key, []);
                  byArea.get(f.region_key)!.push(f);
                }
                const VLABEL: Record<string, string> = {
                  "scooter-110": "Scooter 110cc", "scooter-125": "Scooter 125cc", "scooter-160": "Scooter 160cc",
                  "motorbike-150": "Bike 150cc", "motorbike-300": "Bike 300cc", "motorbike-500": "Bike 500cc", "motorbike-big": "Bike 650cc+",
                  "car-economy": "Car economy", "car-sedan": "Car sedan", "car-suv": "Car SUV", "car-van": "Car van", "car-luxury": "Car luxury",
                };
                return (
                  <div className="space-y-3">
                    {[...byArea.entries()].map(([area, rows]) => (
                      <div key={area} className="rounded-xl border-2 border-line">
                        <div className="flex items-center justify-between bg-card2 px-2 py-1.5">
                          <span className="text-[11px] font-extrabold text-strong">📍 {area}</span>
                          <span className="text-[10px] font-bold text-faint">
                            {rows[0]?.currency} · {rows.length} vehicles
                          </span>
                        </div>
                        <table className="w-full text-[11px]">
                          <thead className="text-left text-[9px] uppercase text-faint">
                            <tr>
                              <th className="p-1.5">Vehicle</th>
                              <th className="p-1.5">Floor/day</th>
                              <th className="p-1.5">Typical</th>
                              <th className="p-1.5">Src</th>
                            </tr>
                          </thead>
                          <tbody>
                            {rows.map((f) => (
                              <tr key={f.id} className="border-t border-line text-soft">
                                <td className="p-1.5 font-bold">{VLABEL[f.vehicle_key] ?? f.vehicle_key}</td>
                                <td className="p-1.5">
                                  <input
                                    defaultValue={f.floor_per_day}
                                    onBlur={async (e) => {
                                      const v = Number(e.target.value);
                                      if (v > 0 && v !== f.floor_per_day) {
                                        await fetch("/api/admin/market", {
                                          method: "PATCH",
                                          headers: { "Content-Type": "application/json" },
                                          body: JSON.stringify({ id: f.id, floor: v }),
                                        });
                                        const m = await (await fetch("/api/admin/market")).json();
                                        if (m.rows) setFloors(m.rows);
                                      }
                                    }}
                                    className="w-14 rounded border border-line bg-card p-1 text-strong"
                                  />
                                </td>
                                <td className="p-1.5">{f.typical_per_day ?? "-"}</td>
                                <td className="p-1.5">{f.source === "owner" ? "👑" : "🤖"}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ))}
                  </div>
                );
              })()
            )}
          </div>

          {/* Anti-Ban engine: trust scores + every policy knob, live-editable */}
          <div className="surface rounded-blob p-4">
            <div className="mb-1 text-[13px] font-extrabold text-strong">
              🛡 Anti-Ban engine
            </div>
            <p className="mb-2 text-[11px] text-faint">
              Dynamic trust scores per connected number (replies build trust and
              relax hourly limits) and every policy knob - edits apply live, no
              redeploy.
            </p>
            {waSec ? (
              <>
                {waSec.reputation.length > 0 && (
                  <div className="mb-3 space-y-1.5">
                    {waSec.reputation.map((r) => {
                      const paused = r.paused_until && new Date(r.paused_until).getTime() > Date.now();
                      const risk = r.risk?.score ?? r.risk_score ?? 0;
                      return (
                        <div key={r.sender_key} className="rounded-xl bg-card2 p-2 text-[11px]">
                          <div className="flex items-center justify-between gap-2">
                            <span className="truncate font-bold text-soft">{r.sender_key}</span>
                            <span
                              className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-extrabold ${
                                risk >= 70
                                  ? "bg-brandred text-white"
                                  : risk >= 40
                                  ? "bg-brandyellow-soft text-[#8a6100] dark:text-brandyellow"
                                  : "bg-savings-soft text-savings"
                              }`}
                            >
                              risk {risk}
                            </span>
                          </div>
                          <div className="mt-0.5 flex flex-wrap gap-x-2 text-[10px] text-faint">
                            <span>trust {r.trust_score}</span>
                            <span>{r.sent_total} sent</span>
                            <span>{r.replies_total} replies</span>
                            {(r.blocks_total ?? 0) > 0 && (
                              <span className="text-brandred">{r.blocks_total} blocks</span>
                            )}
                            {(r.fails_total ?? 0) > 0 && (
                              <span className="text-brandred">{r.fails_total} fails</span>
                            )}
                          </div>
                          {r.risk?.reasons?.length ? (
                            <div className="mt-0.5 text-[10px] text-faint">
                              {r.risk.reasons.join(" · ")}
                            </div>
                          ) : null}
                          {paused && (
                            <div className="mt-1 flex items-center justify-between rounded-lg bg-brandred-soft p-1.5">
                              <span className="text-[10px] font-extrabold text-brandred">
                                ⏸ Paused until {new Date(r.paused_until!).toLocaleTimeString()}
                              </span>
                              <button
                                onClick={async () => {
                                  await fetch("/api/admin/wa-security", {
                                    method: "POST",
                                    headers: { "Content-Type": "application/json" },
                                    body: JSON.stringify({ action: "clear-pause", senderKey: r.sender_key }),
                                  });
                                  loadAgentStudio();
                                }}
                                className="btn btn-sm rounded-lg bg-card px-2 text-[10px] font-extrabold text-brandblue"
                              >
                                Resume
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
                <div className="grid grid-cols-2 gap-2">
                  {Object.entries(waSec.policies).map(([k, v]) => {
                    const h = waSec.help?.[k];
                    return (
                      <label key={k} className="relative rounded-xl border-2 border-line p-2 text-[10px] font-bold text-faint">
                        <span className="flex items-center gap-1">
                          {h?.label ?? k.replace(/_/g, " ")}
                          {h && (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.preventDefault();
                                setWaHelp(waHelp === k ? null : k);
                              }}
                              className="flex h-4 w-4 items-center justify-center rounded-full bg-brandblue-soft text-[9px] font-extrabold text-brandblue"
                            >
                              i
                            </button>
                          )}
                        </span>
                        <input
                          defaultValue={String(v)}
                          onBlur={async (e) => {
                            const val = e.target.value.trim();
                            if (val && val !== String(v)) {
                              const r = await (
                                await fetch("/api/admin/wa-security", {
                                  method: "POST",
                                  headers: { "Content-Type": "application/json" },
                                  body: JSON.stringify({ key: k, value: val }),
                                })
                              ).json();
                              if (r.policies) setWaSec({ ...waSec, policies: r.policies });
                            }
                          }}
                          className="mt-0.5 w-full rounded border border-line bg-card p-1 text-[12px] font-extrabold text-strong"
                        />
                        {waHelp === k && h && (
                          <div className="absolute left-0 top-full z-20 mt-1 w-56 rounded-xl border-2 border-brandblue bg-card p-2.5 text-[11px] shadow-xl">
                            <div className="font-extrabold text-strong">{h.label}</div>
                            <div className="mt-1 font-normal text-soft">{h.help}</div>
                            <div className="mt-1.5 font-bold text-savings">✓ {h.best}</div>
                            <button
                              onClick={(e) => {
                                e.preventDefault();
                                setWaHelp(null);
                              }}
                              className="mt-1.5 text-[10px] font-extrabold text-brandblue"
                            >
                              Close
                            </button>
                          </div>
                        )}
                      </label>
                    );
                  })}
                </div>
              </>
            ) : (
              <SkeletonList count={2} />
            )}
          </div>

          {/* Sponsored shops: paid placements with the glowing Recommended card */}
          <div className="surface rounded-blob p-4">
            <div className="mb-1 flex items-center justify-between">
              <div className="text-[13px] font-extrabold text-strong">⭐ Sponsored shops</div>
              <span className="rounded-full bg-brandblue-soft px-2 py-0.5 text-[10px] font-extrabold text-brandblue">
                {sponsors.filter((s) => s.active).length} live
              </span>
            </div>
            <p className="mb-2 text-[11px] text-faint">
              Shops that pay for placement appear FIRST with a glowing frame and a
              &ldquo;Recommended shop&rdquo; tag. Match by the shop&apos;s Google Maps name
              and/or phone number.
            </p>
            <div className="mb-2 space-y-1.5">
              <input
                value={spName}
                onChange={(e) => setSpName(e.target.value)}
                placeholder="Shop name exactly as on Google Maps"
                className="w-full rounded-xl border-2 border-line bg-card p-2 text-[12px] text-strong focus:border-brandblue focus:outline-none"
              />
              <div className="flex gap-1.5">
                <input
                  value={spPhone}
                  onChange={(e) => setSpPhone(e.target.value)}
                  placeholder="Phone (optional, exact match)"
                  className="flex-1 rounded-xl border-2 border-line bg-card p-2 text-[12px] text-strong focus:border-brandblue focus:outline-none"
                />
                <input
                  value={spNotes}
                  onChange={(e) => setSpNotes(e.target.value)}
                  placeholder="Deal notes (private)"
                  className="flex-1 rounded-xl border-2 border-line bg-card p-2 text-[12px] text-strong focus:border-brandblue focus:outline-none"
                />
              </div>
              <button
                onClick={async () => {
                  if (!spName.trim()) return;
                  const r = await (
                    await fetch("/api/admin/sponsored", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ name: spName, phone: spPhone, notes: spNotes }),
                    })
                  ).json();
                  if (r.rows) {
                    setSponsors(r.rows);
                    setSpName("");
                    setSpPhone("");
                    setSpNotes("");
                  }
                }}
                className="btn btn-primary btn-sm w-full rounded-xl text-[12px]"
              >
                + Add sponsored shop
              </button>
            </div>
            {sponsors.length > 0 && (
              <div className="space-y-1.5">
                {sponsors.map((s) => (
                  <div
                    key={s.id}
                    className="flex items-center justify-between rounded-xl border-2 border-line p-2 text-[11px]"
                  >
                    <div className="min-w-0">
                      <div className="truncate font-extrabold text-strong">
                        {s.active ? "⭐" : "💤"} {s.name}
                      </div>
                      <div className="truncate text-faint">
                        {s.phone ?? "no phone"} {s.notes ? `· ${s.notes}` : ""}
                      </div>
                    </div>
                    <div className="ml-2 flex shrink-0 gap-1.5">
                      <button
                        onClick={async () => {
                          const r = await (
                            await fetch("/api/admin/sponsored", {
                              method: "PATCH",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({ id: s.id, active: !s.active }),
                            })
                          ).json();
                          if (r.rows) setSponsors(r.rows);
                        }}
                        className="btn btn-ghost btn-sm rounded-lg border-2 border-line px-2 text-[10px] font-extrabold text-brandblue"
                      >
                        {s.active ? "Pause" : "Activate"}
                      </button>
                      <button
                        onClick={async () => {
                          const r = await (
                            await fetch(`/api/admin/sponsored?id=${s.id}`, { method: "DELETE" })
                          ).json();
                          if (r.rows) setSponsors(r.rows);
                        }}
                        className="btn btn-ghost btn-sm rounded-lg border-2 border-line px-2 text-[10px] font-extrabold text-brandred"
                      >
                        🗑
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Core prompts: view/edit every agent's brain (never removable) */}
          {isOwner && (
            <div className="surface rounded-blob p-4">
              <div className="mb-1 text-[13px] font-extrabold text-strong">
                🧬 Agent core prompts
              </div>
              <p className="mb-2 text-[11px] text-faint">
                The exact instructions each agent runs on. Edit any of them - changes
                apply live. You can never delete a prompt: clearing the box restores
                the built-in default.
              </p>
              <div className="space-y-2">
                {prompts.map((p) => {
                  const val = promptDraft[p.id] ?? p.override ?? p.def;
                  const overridden = Boolean(p.override);
                  return (
                    <details key={p.id} className="rounded-xl border-2 border-line p-2">
                      <summary className="cursor-pointer text-[12px] font-extrabold text-strong">
                        {p.label}{" "}
                        {overridden && (
                          <span className="rounded-full bg-brandblue-soft px-1.5 py-0.5 text-[9px] font-extrabold text-brandblue">
                            edited
                          </span>
                        )}
                      </summary>
                      <textarea
                        rows={5}
                        value={val}
                        onChange={(e) =>
                          setPromptDraft((d) => ({ ...d, [p.id]: e.target.value }))
                        }
                        className="mt-2 w-full rounded-lg border-2 border-line bg-card p-2 font-mono text-[11px] leading-relaxed text-strong focus:border-brandblue focus:outline-none"
                      />
                      <div className="mt-1.5 flex gap-2">
                        <button
                          onClick={async () => {
                            const r = await (
                              await fetch("/api/admin/prompts", {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ id: p.id, text: val }),
                              })
                            ).json();
                            if (r.prompts) setPrompts(r.prompts);
                            setPromptSaved(p.id);
                            setTimeout(() => setPromptSaved(null), 1500);
                          }}
                          className="btn btn-primary btn-sm flex-1 rounded-lg text-[11px]"
                        >
                          {promptSaved === p.id ? "Saved" : "Save prompt"}
                        </button>
                        <button
                          onClick={async () => {
                            await fetch("/api/admin/prompts", {
                              method: "POST",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({ id: p.id, text: "" }),
                            });
                            setPromptDraft((d) => ({ ...d, [p.id]: p.def }));
                            const r = await (await fetch("/api/admin/prompts")).json();
                            if (r.prompts) setPrompts(r.prompts);
                          }}
                          className="btn btn-ghost btn-sm rounded-lg border-2 border-line px-3 text-[11px] font-extrabold text-brandred"
                        >
                          Reset to default
                        </button>
                      </div>
                    </details>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {loaded && tab === "intel" && (
        <div className="space-y-3">
          <div className="surface rounded-blob p-4">
            <div className="mb-1 flex items-center justify-between">
              <div className="text-[13px] font-extrabold text-strong">
                📊 Shop-price intelligence
              </div>
              <button
                onClick={loadIntel}
                className="btn btn-sm chip rounded-xl border-2 border-line px-3 text-[11px] font-extrabold text-brandblue"
              >
                ↻ Refresh
              </button>
            </div>
            <p className="text-[11px] text-faint">
              Every REAL price shops have quoted us, by area and vehicle type - the
              lowest, highest and average per day, typical rental length, how many
              shops, and how often they offer delivery. Built automatically from the
              funnel. {intel ? `${intel.totalOffers} offers analysed.` : ""}
            </p>
          </div>
          {!intel ? (
            <SkeletonList count={3} />
          ) : intel.areas.length === 0 ? (
            <div className="surface rounded-blob p-4 text-center text-[12px] text-faint">
              No offers yet - once shops start quoting through the funnel, their real
              prices are aggregated here by area and vehicle type.
            </div>
          ) : (
            intel.areas.map((a) => (
              <div key={a.area} className="surface rounded-blob p-3">
                <div className="mb-1.5 text-[12px] font-extrabold text-strong">📍 {a.area}</div>
                <div className="overflow-x-auto">
                  <table className="w-full text-[11px]">
                    <thead className="text-left text-[9px] uppercase text-faint">
                      <tr>
                        <th className="p-1">Vehicle</th>
                        <th className="p-1">Low</th>
                        <th className="p-1">Avg</th>
                        <th className="p-1">High</th>
                        <th className="p-1">Days</th>
                        <th className="p-1">Shops</th>
                        <th className="p-1">Deliv.</th>
                      </tr>
                    </thead>
                    <tbody>
                      {a.vehicles.map((v) => (
                        <tr key={v.vehicle} className="border-t border-line text-soft">
                          <td className="p-1 font-bold">{v.vehicle}</td>
                          <td className="p-1 text-savings">{v.low} {v.currency}</td>
                          <td className="p-1">{v.avg}</td>
                          <td className="p-1 text-brandred">{v.high}</td>
                          <td className="p-1">{v.typicalDays ?? "-"}</td>
                          <td className="p-1">{v.shops} <span className="text-faint">({v.samples})</span></td>
                          <td className="p-1">{v.deliverRate}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {loaded && tab === "analytics" && analytics && (
        <div className="space-y-3">
          {/* Cost tracker: every request against the free quotas + est. cost */}
          {costs && (
            <div className="surface rounded-blob p-4">
              <div className="flex items-center justify-between">
                <div className="text-[13px] font-extrabold text-strong">💰 Cost tracker (this month)</div>
                {isOwner && (
                  <button
                    onClick={async () => {
                      await fetch("/api/admin/costs", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ killSwitch: !costs.killSwitch }),
                      });
                      await refreshCosts();
                    }}
                    className={`btn btn-sm chip rounded-xl px-3 text-[11px] font-extrabold ${
                      costs.killSwitch ? "bg-brandred text-white" : "bg-card2 text-soft"
                    }`}
                  >
                    {costs.killSwitch ? "🔴 KILL SWITCH ON - tap to resume" : "⭕ Kill switch (owner)"}
                  </button>
                )}
              </div>
              {costs.killSwitch && (
                <p className="mt-1 rounded-xl bg-brandred-soft p-2 text-[11px] font-bold text-brandred">
                  All paid services and payments are PAUSED for every user.
                </p>
              )}
              <div className="mt-2 space-y-2">
                {(costs.apis ?? []).map((a: any) => (
                  <div key={a.kind}>
                    <div className="flex justify-between text-[11px] font-bold text-soft">
                      <span>{a.label}</span>
                      <span>
                        {a.used.toLocaleString()} / {a.free.toLocaleString()} free
                        {a.estCostUsd > 0 ? ` · ~$${a.estCostUsd} over` : " · $0.00"}
                      </span>
                    </div>
                    <div className="mt-0.5 h-1.5 w-full overflow-hidden rounded-full bg-line">
                      <div
                        className={`h-full rounded-full ${
                          a.used >= a.free ? "bg-brandred" : a.used >= a.free * 0.8 ? "bg-brandyellow" : "bg-savings"
                        }`}
                        style={{ width: `${Math.min(100, (a.used / a.free) * 100)}%` }}
                      />
                    </div>
                  </div>
                ))}
                <div className="text-[11px] text-faint">
                  AI: {costs.stats?.aiCalls ?? 0} calls ·{" "}
                  {Object.entries(costs.aiTokens ?? {})
                    .map(([p, n]) => `${p} ${(n as number).toLocaleString()} tok`)
                    .join(" · ") || "0 tokens"}
                </div>
                {(costs.stats?.searchesThisMonth ?? 0) === 0 &&
                  (costs.stats?.aiCalls ?? 0) === 0 && (
                    <div className="rounded-xl bg-card2 p-2 text-[10px] text-faint">
                      No billable API usage recorded yet this month. Numbers
                      appear here as soon as real searches (Google Maps key set)
                      or AI calls happen. If you have used the app and this stays
                      at zero, run Test Supabase - the api_usage table may be
                      missing (re-run schema.sql).
                    </div>
                  )}
              </div>

              {/* Abuse limits - adjustable */}
              <div className="mt-3 border-t border-line pt-2">
                <div className="text-[12px] font-extrabold text-strong">🛡 Per-user abuse limits</div>
                <div className="mt-1 grid grid-cols-2 gap-2">
                  {Object.keys(costs.defaults ?? {}).map((name) => (
                    <label key={name} className="text-[10px] font-bold text-faint">
                      {name.replace("LIMIT_", "").replace(/_/g, " ").toLowerCase()}
                      <input
                        type="number"
                        min={1}
                        value={limitEdit[name] ?? ""}
                        onChange={(e) => setLimitEdit((p) => ({ ...p, [name]: e.target.value }))}
                        className="mt-0.5 w-full rounded-lg border-2 border-line bg-card p-1.5 text-[12px] font-bold text-strong"
                      />
                    </label>
                  ))}
                </div>
                <button
                  onClick={async () => {
                    setLimitsBusy(true);
                    try {
                      await fetch("/api/admin/costs", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                          limits: Object.fromEntries(
                            Object.entries(limitEdit).map(([k, v]) => [k, Number(v)])
                          ),
                        }),
                      });
                      await refreshCosts();
                    } finally {
                      setLimitsBusy(false);
                    }
                  }}
                  disabled={limitsBusy}
                  className="btn btn-primary btn-sm mt-2 w-full rounded-xl text-[12px] disabled:opacity-60"
                >
                  {limitsBusy ? <LoadingDots light label="Saving" /> : "Save limits"}
                </button>
              </div>
            </div>
          )}

          {/* Real durable stats (this month, from Supabase) */}
          <div className="grid grid-cols-2 gap-2">
            <Metric label="Searches this month" value={String(costs?.stats?.searchesThisMonth ?? 0)} accent />
            <Metric label="Offers received" value={String(costs?.stats?.offersThisMonth ?? 0)} />
            <Metric label="Messages sent" value={String(costs?.stats?.messagesSent ?? 0)} />
            <Metric label="Total users" value={String(costs?.stats?.totalUsers ?? 0)} />
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

      {loaded && tab === "keys" && (
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

          {/* WhatsApp host pool: live health + load across every free server */}
          <div className="surface rounded-blob p-4">
            <div className="flex items-center justify-between">
              <div className="text-[13px] font-extrabold text-strong">📡 WhatsApp host pool</div>
              <button
                onClick={loadWaHosts}
                disabled={waHostsBusy}
                className="btn btn-sm chip rounded-xl border-2 border-line px-3 text-[11px] font-extrabold text-brandblue disabled:opacity-60"
              >
                {waHostsBusy ? <LoadingDots label="Checking" /> : waHosts ? "Refresh" : "Check hosts"}
              </button>
            </div>
            <p className="mb-2 mt-1 text-[11px] text-faint">
              Every free Evolution server you added in EVOLUTION_HOSTS, live. Users
              auto-spread across the healthy ones and fail over instantly if one sleeps.
            </p>
            {waHosts && (
              <>
                <div className="mb-2 flex gap-2">
                  <span className="rounded-full bg-savings-soft px-2 py-0.5 text-[10px] font-extrabold text-savings">
                    {waHosts.healthy}/{waHosts.total} healthy
                  </span>
                  <span className="rounded-full bg-brandblue-soft px-2 py-0.5 text-[10px] font-extrabold text-brandblue">
                    {waHosts.users} live sessions
                  </span>
                </div>
                {waHosts.total === 0 ? (
                  <p className="rounded-lg bg-card2 p-2 text-[11px] font-bold text-faint">
                    No hosts yet. Paste one url|key per line into EVOLUTION_HOSTS below,
                    then follow the deploy guide in GUIDE.md.
                  </p>
                ) : (
                  <div className="space-y-1.5">
                    {waHosts.hosts.map((h) => (
                      <div
                        key={h.url}
                        className="rounded-xl border-2 border-line p-2"
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex min-w-0 items-center gap-2">
                            <span
                              className={`h-2.5 w-2.5 shrink-0 rounded-full ${
                                h.healthy ? "bg-savings" : "bg-brandred"
                              }`}
                            />
                            <span className="truncate font-mono text-[11px] text-soft">
                              {h.url.replace(/^https?:\/\//, "")}
                            </span>
                          </div>
                          <span className="ml-2 shrink-0 text-[10px] font-extrabold text-faint">
                            {h.users} user{h.users === 1 ? "" : "s"}
                          </span>
                        </div>
                        {h.detail && (
                          <p
                            className={`mt-1 text-[10px] font-bold ${
                              h.healthy ? "text-savings" : "text-brandred"
                            }`}
                          >
                            {h.detail}
                          </p>
                        )}
                        <button
                          onClick={() => testOneWaHost(h.url)}
                          disabled={waHostTest[h.url]?.busy}
                          className="btn btn-sm chip mt-1.5 rounded-lg border-2 border-line px-2.5 text-[10px] font-extrabold text-brandblue disabled:opacity-60"
                        >
                          {waHostTest[h.url]?.busy ? <LoadingDots label="Testing" /> : "🩺 Test this server"}
                        </button>
                        {waHostTest[h.url] && !waHostTest[h.url].busy && waHostTest[h.url].detail && (
                          <p
                            className={`mt-1 rounded-lg p-1.5 text-[10px] font-bold ${
                              waHostTest[h.url].ok ? "bg-savings-soft text-savings" : "bg-brandred-soft text-brandred"
                            }`}
                          >
                            {waHostTest[h.url].detail}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </>
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
          {(() => {
            const order = ["ai", "messaging", "maps", "email", "billing", "auth", "data"];
            const groupLabel: Record<string, string> = {
              ai: "🧠 AI providers",
              messaging: "💬 WhatsApp & messaging",
              maps: "🗺 Google Maps",
              email: "✉️ Email",
              billing: "💳 Payments & ads",
              auth: "🔐 Auth & social",
              data: "🗄 Data (bootstrap)",
            };
            const sorted = [...keys].sort(
              (a, b) => order.indexOf(a.scope) - order.indexOf(b.scope)
            );
            let lastScope = "";
            return sorted.map((k) => {
              const header =
                k.scope !== lastScope ? (
                  <div
                    key={`hdr-${k.scope}`}
                    className="px-1 pt-3 text-[11px] font-extrabold uppercase tracking-wide text-faint"
                  >
                    {groupLabel[k.scope] ?? k.scope}
                  </div>
                ) : null;
              lastScope = k.scope;
              return (
                <div key={k.name}>
                  {header}
                  <div className="surface rounded-blob p-4">
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
                    {!k.configured && k.docUrl && (
                      <a
                        href={k.docUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-1 inline-block text-[11px] font-extrabold text-brandblue underline"
                      >
                        Get this key ↗
                      </a>
                    )}
              <div className="mt-2 font-mono text-[12px] text-soft">{k.masked}</div>
              {k.editable && (
                <>
                  <button
                    onClick={() => testKey(k.name)}
                    disabled={keyTestBusy !== null}
                    className="btn btn-sm chip mt-2 rounded-xl border-2 border-line px-3 text-[11px] font-extrabold text-brandblue disabled:opacity-60"
                  >
                    {keyTestBusy === k.name ? <LoadingDots label="Testing" /> : "🩺 Test API"}
                  </button>
                  {keyTests[k.name] && (
                    <p
                      className={`mt-1 rounded-lg p-2 text-[11px] font-bold ${
                        keyTests[k.name].ok
                          ? "bg-savings-soft text-savings"
                          : "bg-brandred-soft text-brandred"
                      }`}
                    >
                      {keyTests[k.name].detail}
                    </p>
                  )}
                </>
              )}
              {k.editable ? (
                k.name === "EVOLUTION_HOSTS" ? (
                  <div className="mt-2">
                    <textarea
                      rows={4}
                      placeholder={"https://host-1.onrender.com|apikey1\nhttps://host-2.koyeb.app|apikey2\nhttps://host-3.fly.dev|apikey3"}
                      value={editing[k.name] ?? ""}
                      onChange={(e) => setEditing((ed) => ({ ...ed, [k.name]: e.target.value }))}
                      className="w-full rounded-xl border-2 border-line bg-card p-2 font-mono text-[12px] text-strong focus:border-brandblue focus:outline-none"
                    />
                    <p className="mt-1 text-[11px] text-faint">
                      One server per line as <span className="font-mono">url|apikey</span>. Add up
                      to 8+ free servers - users spread across them and fail over automatically.
                    </p>
                    <button
                      onClick={() => saveKey(k.name)}
                      disabled={savingKey === k.name}
                      className="btn btn-primary btn-sm mt-2 w-full rounded-xl px-3 text-[12px] disabled:opacity-60"
                    >
                      {savingKey === k.name ? <LoadingDots light /> : saved === k.name ? "Saved" : "Apply pool"}
                    </button>
                  </div>
                ) : (
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
                )
                    ) : (
                      <div className="mt-2 text-[11px] text-faint">
                        Bootstrap secret - set via host environment variables only.
                      </div>
                    )}
                  </div>
                </div>
              );
            });
          })()}
        </div>
      )}

      {loaded && tab === "users" && (
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
                  <button
                    onClick={() => {
                      if (
                        confirm(
                          `Permanently erase ${u.email}? This deletes their account, data, and WhatsApp link. This cannot be undone.`
                        )
                      )
                        userAction({ email: u.email, action: "delete" });
                    }}
                    className="btn btn-sm chip rounded-xl border-2 border-brandred/40 px-3 py-1.5 text-[12px] font-extrabold text-brandred"
                    title="Permanently erase this user"
                  >
                    🗑 Erase
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {loaded && tab === "data" && (
        <div className="space-y-3">
          <div className="surface rounded-blob p-4">
            <div className="text-[13px] font-extrabold text-strong">🗄 Data explorer</div>
            <p className="mb-2 text-[11px] text-faint">
              Every record the app stores. Read-only, newest first. Tap a table to view.
            </p>
            <div className="flex flex-wrap gap-1.5">
              {dataTables.map((tbl) => (
                <button
                  key={tbl.name}
                  onClick={() => openDataTable(tbl.name)}
                  className={`btn btn-sm chip rounded-xl border-2 px-3 py-1.5 text-[11px] font-extrabold ${
                    dataTable === tbl.name ? "border-brandblue bg-brandblue-soft text-brandblue" : "border-line text-soft"
                  }`}
                >
                  {tbl.label} <span className="text-faint">({tbl.count})</span>
                </button>
              ))}
            </div>
          </div>

          {dataBusy && <SkeletonList count={3} />}

          {!dataBusy && dataTable && (
            <div className="surface rounded-blob p-4">
              <div className="mb-2 text-[13px] font-extrabold text-strong">
                {dataTables.find((t) => t.name === dataTable)?.label ?? dataTable}
                <span className="ml-2 text-[11px] font-bold text-faint">{dataRows.length} rows</span>
              </div>
              {dataRows.length === 0 ? (
                <p className="rounded-xl bg-card2 p-3 text-center text-[11px] font-bold text-faint">
                  No records yet.
                </p>
              ) : (
                <div className="space-y-2">
                  {dataRows.map((row, i) => (
                    <details key={i} className="rounded-xl border-2 border-line p-2.5">
                      <summary className="cursor-pointer truncate text-[11px] font-bold text-soft">
                        {String(
                          (row as any).email ??
                            (row as any).vendor_name ??
                            (row as any).type ??
                            (row as any).event ??
                            (row as any).text ??
                            Object.values(row)[1] ??
                            `row ${i + 1}`
                        ).slice(0, 60)}
                      </summary>
                      <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-card2 p-2 text-[10px] leading-relaxed text-soft">
                        {JSON.stringify(row, null, 2)}
                      </pre>
                    </details>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {loaded && tab === "feedback" && (
        <div className="space-y-3">
          {/* Summary counts */}
          <div className="grid grid-cols-3 gap-2">
            <Metric
              label="High severity"
              value={String(feedbackRows.filter((f) => f.is_real_issue && f.severity === "high").length)}
              accent
            />
            <Metric label="Real issues" value={String(feedbackRows.filter((f) => f.is_real_issue).length)} />
            <Metric label="Total" value={String(feedbackRows.length)} />
          </div>
          {/* Filter chips */}
          <div className="flex gap-1.5">
            {(["all", "high", "issues", "noise"] as const).map((fl) => (
              <button
                key={fl}
                onClick={() => setFeedbackFilter(fl)}
                className={`chip flex-1 rounded-xl border-2 py-1.5 text-[11px] font-extrabold capitalize ${
                  feedbackFilter === fl
                    ? "border-brandblue bg-brandblue-soft text-brandblue"
                    : "border-line text-soft"
                }`}
              >
                {fl}
              </button>
            ))}
          </div>
          {feedbackRows.length === 0 && (
            <div className="surface rounded-blob p-4 text-center text-[12px] text-faint">
              No feedback yet (or Supabase is not connected - run Test Supabase
              in Keys).
            </div>
          )}
          {feedbackRows
            .filter((f) =>
              feedbackFilter === "all"
                ? true
                : feedbackFilter === "high"
                ? f.is_real_issue && f.severity === "high"
                : feedbackFilter === "issues"
                ? f.is_real_issue
                : !f.is_real_issue
            )
            .map((f) => (
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
              {(f.images?.length ?? 0) > 0 && (
                <div className="no-scrollbar mt-2 flex gap-2 overflow-x-auto">
                  {f.images!.map((src, i) => (
                    <a key={i} href={src} target="_blank" rel="noreferrer" className="shrink-0">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={src}
                        alt=""
                        className="h-24 w-24 rounded-xl border-2 border-line object-cover"
                      />
                    </a>
                  ))}
                </div>
              )}
              <div className="mt-1 text-[10px] text-faint">
                {f.reporter_email ?? "anonymous"}
                {f.image_count > 0 ? ` · ${f.image_count} screenshot(s)` : ""}
                {f.triage_reason ? ` · ${f.triage_reason}` : ""}
              </div>

              {/* Triage workflow: status chips + owner note (New#11) */}
              <div className="mt-2 flex flex-wrap gap-1">
                {(["open", "in-progress", "resolved", "dismissed"] as const).map((st) => {
                  const active = (f.status ?? "open") === st;
                  return (
                    <button
                      key={st}
                      onClick={async () => {
                        await fetch("/api/admin/feedback", {
                          method: "PATCH",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ id: f.id, status: st }),
                        });
                        setFeedbackRows((rows) =>
                          rows.map((r) => (r.id === f.id ? { ...r, status: st } : r))
                        );
                      }}
                      className={`chip rounded-lg border-2 px-2 py-0.5 text-[10px] font-extrabold capitalize ${
                        active
                          ? st === "resolved"
                            ? "border-savings bg-savings-soft text-savings"
                            : st === "dismissed"
                            ? "border-line bg-card2 text-faint"
                            : st === "in-progress"
                            ? "border-brandyellow bg-brandyellow-soft text-[#8a6100] dark:text-brandyellow"
                            : "border-brandblue bg-brandblue-soft text-brandblue"
                          : "border-line text-faint"
                      }`}
                    >
                      {st}
                    </button>
                  );
                })}
              </div>
              <textarea
                rows={1}
                defaultValue={f.owner_note ?? ""}
                placeholder="Add an owner note (what you'll do about it)..."
                onBlur={async (e) => {
                  const note = e.target.value.trim();
                  if (note !== (f.owner_note ?? "")) {
                    await fetch("/api/admin/feedback", {
                      method: "PATCH",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ id: f.id, note }),
                    });
                    setFeedbackRows((rows) =>
                      rows.map((r) => (r.id === f.id ? { ...r, owner_note: note } : r))
                    );
                  }
                }}
                className="mt-1.5 w-full rounded-lg border-2 border-line bg-card p-1.5 text-[11px] text-strong focus:border-brandblue focus:outline-none"
              />
            </div>
          ))}
        </div>
      )}

      {loaded && tab === "billing" && (
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
      <div className="rise-in px-4 pt-4">{children}</div>
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
