"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { Icon } from "@/components/icons";
import { BrandMark } from "@/components/BrandMark";
import { LoadingDots } from "@/components/LoadingDots";
import { SkeletonList } from "@/components/Skeleton";
import { LanguageButton } from "@/components/LanguageButton";
import { PlanCard, type PlanView } from "@/components/UpgradeSheet";
import { PlaceAutocomplete } from "@/components/PlaceAutocomplete";

// The agents + keys sub-panels are heavy (trace viewer, simulator, health
// probes) and only appear on two tabs, so code-split them out of the initial
// admin bundle - first paint of the common tabs no longer pays for them.
const OrchestratorPanel = dynamic(
  () => import("@/components/studio/PipelineStudio").then((m) => m.PipelineStudio),
  { ssr: false, loading: () => <LoadingDots label="Loading the Pipeline Studio" /> }
);
const HealthPanel = dynamic(
  () => import("@/components/HealthPanel").then((m) => m.HealthPanel),
  { ssr: false, loading: () => <LoadingDots label="Loading service health" /> }
);
const WaDoctorCard = dynamic(
  () => import("@/components/admin/WaDoctorCard").then((m) => m.WaDoctorCard),
  { ssr: false, loading: () => <LoadingDots label="Loading WA doctor" /> }
);
const OpsCenterPanel = dynamic(
  () => import("@/components/ops/OpsCenter").then((m) => m.OpsCenter),
  { ssr: false, loading: () => <LoadingDots label="Loading the Ops Center" /> }
);
// The live ENGINE_V3 transparency view that replaces the retired graph debug tabs.
const EngineInspectorPanel = dynamic(
  () => import("@/components/admin/EngineInspector").then((m) => m.EngineInspector),
  { ssr: false, loading: () => <LoadingDots label="Reading the live blackboard" /> }
);
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
  replies?: {
    id: number;
    author_role: string;
    author_email: string | null;
    body: string;
    created_at: string;
  }[];
}

/** User-visible reply thread on a feedback report (owner/admin side). Distinct
 *  from the internal owner_note - this is what the reporter reads and answers. */
function AdminReplyThread({
  report,
  onReplied,
}: {
  report: FeedbackRow;
  onReplied: (reply: NonNullable<FeedbackRow["replies"]>[number]) => void;
}) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const replies = report.replies ?? [];

  async function send() {
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/feedback/reply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ feedbackId: report.id, body: text }),
      });
      if (res.ok) {
        onReplied({
          id: Date.now(),
          author_role: "owner",
          author_email: null,
          body: text,
          created_at: new Date().toISOString(),
        });
        setDraft("");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-2 rounded-lg border border-line bg-card2/40 p-1.5">
      <div className="text-[9px] font-extrabold uppercase tracking-wide text-faint">
        Reply to the user{report.reporter_email ? "" : " (anonymous - no reply channel)"}
      </div>
      {replies.length > 0 && (
        <div className="mt-1 space-y-1">
          {replies.map((rp) => (
            <div
              key={rp.id}
              className={`text-[11px] ${
                rp.author_role === "user" ? "text-strong" : "text-brandblue"
              }`}
            >
              <b>{rp.author_role === "user" ? "User" : "Team"}:</b> {rp.body}
            </div>
          ))}
        </div>
      )}
      {report.reporter_email && (
        <div className="mt-1 flex items-center gap-1.5">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") send();
            }}
            disabled={busy}
            placeholder="Write a reply the user will see..."
            className="h-8 min-w-0 flex-1 rounded-lg border-2 border-line bg-card px-2 text-[11px] text-strong focus:border-brandblue focus:outline-none disabled:opacity-60"
          />
          <button
            onClick={send}
            disabled={busy || !draft.trim()}
            className="btn btn-sm btn-primary h-8 shrink-0 rounded-lg px-2.5 text-[10px] font-extrabold disabled:opacity-50"
          >
            Send
          </button>
        </div>
      )}
    </div>
  );
}

export default function AdminPage() {
  const [authorized, setAuthorized] = useState<boolean | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [tab, setTab] = useState<
    "command" | "analytics" | "engine" | "agents" | "ops" | "keys" | "users" | "feedback" | "billing" | "data"
  >("command");
  // Keys page: collapse each scope group so the long page is easy to walk.
  const [collapsedScopes, setCollapsedScopes] = useState<Record<string, boolean>>({
    maps: true,
    email: true,
    billing: true,
    auth: true,
    data: true,
  });
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
  const [waPolicyErr, setWaPolicyErr] = useState<{ key: string; error: string } | null>(null);
  const [sponsors, setSponsors] = useState<
    { id: number; name: string; phone: string | null; active: boolean; notes: string | null }[]
  >([]);
  const [spName, setSpName] = useState("");
  const [spPhone, setSpPhone] = useState("");
  const [spNotes, setSpNotes] = useState("");
  // Interactive train-the-agent studio (New#13)
  const [tcTurns, setTcTurns] = useState<{ role: "shop" | "agent"; text: string }[]>([]);
  const [tcInput, setTcInput] = useState("");
  // The scenario area for the live trainer. Location suggestions now come from
  // the shared PlaceAutocomplete; typed free-text still works as the area.
  const [tcRegion, setTcRegion] = useState("");
  const [tcBusy, setTcBusy] = useState(false);
  const [tcInfo, setTcInfo] = useState<{
    action: string; reasoning: string;
    understood: { foundPrice: number | null; currency: string; matchesVehicle: boolean; confidence: string };
  } | null>(null);
  const [tcSaved, setTcSaved] = useState(false);

  async function tcSend() {
    const text = tcInput.trim();
    if (!text || tcBusy) return;
    const turns = [...tcTurns, { role: "shop" as const, text }];
    setTcTurns(turns);
    setTcInput("");
    setTcBusy(true);
    try {
      const res = await fetch("/api/admin/train-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ turns, region: tcRegion }),
      });
      const r = await res.json().catch(() => ({}));
      if (r.agentMessage) {
        setTcTurns([...turns, { role: "agent", text: r.agentMessage }]);
        setTcInfo({ action: r.action, reasoning: r.reasoning, understood: r.understood });
      } else {
        // Never leave the trainer silent - always show WHY the agent could not reply.
        setTcTurns([
          ...turns,
          {
            role: "agent",
            text:
              r.error ??
              "The agent could not respond just now. Check that an AI key is set in Admin -> Keys, then try again.",
          },
        ]);
      }
    } catch {
      setTcTurns([
        ...turns,
        { role: "agent", text: "Network hiccup reaching the agent - please try again." },
      ]);
    } finally {
      setTcBusy(false);
    }
  }
  async function tcSave() {
    await fetch("/api/admin/train-chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "save", turns: tcTurns, region: tcRegion }),
    });
    setTcSaved(true);
    setTimeout(() => setTcSaved(false), 2000);
    refreshMemory();
  }

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

  // Command also hosts the foldable Anti-Ban + Sponsored sections (item #16).
  async function loadCommand() {
    const [r, s, sp] = await Promise.all([
      (await fetch("/api/admin/command")).json(),
      (await fetch("/api/admin/wa-security")).json(),
      (await fetch("/api/admin/sponsored")).json(),
    ]);
    if (r.alerts) setCommand(r);
    if (s.policies) setWaSec(s);
    if (sp.rows) setSponsors(sp.rows);
  }
  // Analytics hosts the foldable market-floors table (item #16).
  async function loadFloors() {
    const m = await (await fetch("/api/admin/market")).json();
    if (m.rows) setFloors(m.rows);
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
  // TRI-STATE (null = still checking). It used to default to `false`, so the
  // alarming "Persistence is OFF" banner was shown for the entire duration of
  // the initial 7-way load - including the slow live health probes - and only
  // then flipped green. Unknown must never render as broken.
  const [persistent, setPersistent] = useState<boolean | null>(null);
  const [plans, setPlans] = useState<PlanView[]>([]);
  const [billingOn, setBillingOn] = useState(false);
  const [newAdmin, setNewAdmin] = useState("");
  const [userMsg, setUserMsg] = useState<string | null>(null);
  const [isOwner, setIsOwner] = useState(false);
  const [keyWarning, setKeyWarning] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<{ name: string; label: string; value: string }[] | null>(null);
  const [aiProviders, setAiProviders] = useState<any[]>([]);
  const [distillMsg, setDistillMsg] = useState<string | null>(null);
  const [distillBusy, setDistillBusy] = useState(false);
  const [trainingCount, setTrainingCount] = useState(0);
  const [trainMsg, setTrainMsg] = useState<string | null>(null);
  const [trainOk, setTrainOk] = useState(true);
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
      // Analytics doubles as the auth gate, so it runs first. Everything else
      // then loads IN PARALLEL - the panel used to await nine round-trips one
      // after another, so first paint waited on the SUM of every latency.
      const a = await fetch("/api/admin/analytics");
      if (a.status === 403) {
        setAuthorized(false);
        return;
      }
      setAuthorized(true);
      setAnalytics(await a.json());
      // FIRST PAINT NOW: the shell + tabs render after ONE round trip. The
      // batch below fills each section in as it lands - one slow lambda
      // (ai-status probing providers, a cold users query) must never hold the
      // whole workspace hostage on skeletons.
      setLoaded(true);

      const j = (r: PromiseSettledResult<Response>) =>
        r.status === "fulfilled" ? r.value.json().catch(() => ({})) : Promise.resolve({});

      // KEYS + PERSISTENCE FIRST, on their own round trip. These were batched
      // with ai-status (which probes every provider over the network), so the
      // Keys page and the persistence banner waited on the SLOWEST call in the
      // group - minutes on a cold start. They are cheap; nothing may block them.
      const cfgOnly = await Promise.allSettled([fetch("/api/admin/config")]);
      const cfgEarly = await j(cfgOnly[0]);
      if (cfgEarly.keys) {
        setKeys(cfgEarly.keys);
        setPersistent(Boolean(cfgEarly.persistent));
        const early = (cfgEarly.keys as KeyInfo[]).find((k) => k.name === "APP_DOMAIN");
        if (early && !early.configured) setCollapsedScopes((c) => ({ ...c, auth: false }));
      }

      const [uR, billR, meR, aiR, trR, fbR] = await Promise.allSettled([
        fetch("/api/admin/users"),
        fetch("/api/billing/checkout"),
        fetch("/api/auth/me"),
        fetch("/api/admin/ai-status"),
        fetch("/api/admin/training"),
        fetch("/api/admin/feedback"),
      ]);
      const [u, bill, me, ai, tr, fb] = await Promise.all([
        j(uR), j(billR), j(meR), j(aiR), j(trR), j(fbR),
      ]);
      const cfg = cfgEarly;
      setKeys(cfg.keys ?? []);
      // Surface the "Public app domain" field: while APP_DOMAIN is unset, the
      // 🔐 Auth & social group starts EXPANDED so the one key that fixes the
      // webhook/share/SEO origin is never hidden behind a collapsed header.
      const appDomain = (cfg.keys ?? []).find((k: KeyInfo) => k.name === "APP_DOMAIN");
      if (appDomain && !appDomain.configured) {
        setCollapsedScopes((s) => ({ ...s, auth: false }));
      }
      setPersistent(Boolean(cfg.persistent));
      setUsers(u.users ?? []);
      setPlans(bill.plans ?? []);
      setBillingOn(Boolean(bill.configured));
      setIsOwner(me.session?.role === "owner");
      setAiProviders(ai.providers ?? []);
      setTrainingCount((tr.examples ?? []).length);
      setMemory(tr.examples ?? []);
      setFeedbackRows(fb.feedback ?? []);
      // Costs are non-blocking - never make first paint wait on them.
      refreshCosts().catch(() => {});
    })().catch(() => setAuthorized(false));
  }, []);

  // Auto-probe the WhatsApp host pool the first time the owner opens Keys.
  useEffect(() => {
    if (tab === "keys" && waHosts === null && !waHostsBusy) loadWaHosts();
    if (tab === "data" && dataTables.length === 0) loadDataTables();
    if (tab === "command" && !command) loadCommand().catch(() => {});
    if (tab === "analytics" && floors.length === 0) loadFloors().catch(() => {});
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

  async function runDiag(kind: "supabase" | "maps" | "email") {
    setDiagBusy(kind);
    setDiag(null);
    try {
      if (kind === "email") {
        // Sends a REAL email through the production chain to the admin's own
        // address, so "I entered the env values" becomes a verified fact.
        const res = await fetch("/api/admin/email-test", { method: "POST" });
        const d = await res.json();
        const s = d.status ?? {};
        const providers = `Providers configured - Gmail: ${s.gmail ? "yes" : "no"}, Brevo: ${
          s.brevo ? "yes" : "no"
        }, Resend: ${s.resend ? "yes" : "no"}.`;
        const outcome = d.sent
          ? `✅ Sent via ${d.provider} to ${d.to}. Check that inbox (and spam).`
          : `❌ Not sent${d.provider ? ` (tried ${d.provider})` : ""}: ${d.error ?? "unknown"}`;
        setDiag({
          kind,
          ok: Boolean(d.sent),
          text: [outcome, d.hint ? `Hint: ${d.hint}` : "", providers].filter(Boolean).join("\n"),
        });
        return;
      }
      const res = await fetch(kind === "supabase" ? "/api/admin/supabase-test" : "/api/admin/maps-test");
      const d = await res.json();
      if (kind === "supabase") {
        setDiag({ kind, ok: Boolean(d.appConfigOk), text: d.detail ?? "No result." });
      } else {
        const lines = [
          `Places API (New): ${d.placesNew?.ok ? "OK" : "FAILED"} - ${d.placesNew?.detail}`,
          `Places Autocomplete (New): ${d.placesAutocomplete?.ok ? "OK" : "FAILED"} - ${d.placesAutocomplete?.detail}`,
          `Places API (legacy): ${d.placesLegacy?.ok ? "OK" : "FAILED"} - ${d.placesLegacy?.detail}`,
          `Geocoding: ${d.geocoding?.ok ? "OK" : "FAILED"} - ${d.geocoding?.detail}`,
          // Shop photos are their own billed SKU and can fail alone. Without
          // this line the panel read all-green while every card photo was
          // broken, because nothing here had ever fetched an actual image.
          `Place Photos: ${d.placePhotos?.ok ? "OK" : "FAILED"} - ${d.placePhotos?.detail}`,
        ];
        setDiag({
          kind,
          ok: Boolean((d.placesNew?.ok || d.placesLegacy?.ok) && d.placePhotos?.ok),
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
    // SURFACE FAILURES. This used to update nothing when the POST returned an
    // error (unknown provider, or a vault write that did not persist), so the
    // star silently stayed on the old provider and the click looked ignored.
    if (data.error || (!res.ok && !data.providers)) {
      setKeyWarning(
        `Could not switch provider: ${data.error ?? res.status}. If persistence is off, the choice cannot be saved.`
      );
    } else if (data.warning) {
      setKeyWarning(data.warning);
    }
  }

  async function runDistill() {
    setDistillBusy(true);
    setDistillMsg(null);
    try {
      const res = await fetch("/api/admin/distill", { method: "POST" });
      const d = await res.json();
      setDistillMsg(
        d.error
          ? `⚠ ${d.error}`
          : `✓ Distilled ${d.written ?? 0} exemplar(s) from ${d.mined ?? 0} winning turn(s)${
              d.provider ? ` via ${d.provider}` : ""
            }.`
      );
    } catch {
      setDistillMsg("⚠ Could not run distillation - try again.");
    } finally {
      setDistillBusy(false);
    }
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
        setTrainOk((data.imported ?? 0) > 0);
        setTrainMsg(data.note ?? "Done.");
        await refreshMemory();
      } else {
        setTrainOk(false);
        setTrainMsg(data.error ?? "Could not import.");
      }
    } catch {
      setTrainOk(false);
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
        {/* Legacy "Agents" (graph Pipeline Studio) and "Ops" (graph-era Ops
            Center) tabs are RETIRED from the workspace nav - the app runs on the
            single-pass engine now, so the old graph-pipeline surfaces are no
            longer shown. Their code remains for data/learning continuity but is
            not reachable from the UI. */}
        {(["command", "analytics", "engine", "keys", "users", "feedback", "billing", "data"] as const)
          .map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`btn btn-sm shrink-0 rounded-xl px-3 py-2 text-[11px] font-extrabold capitalize ${
              tab === t ? "bg-brandblue text-white" : "text-soft hover:bg-card2"
            }`}
          >
            {t === "command" ? "🎯 command" : t === "engine" ? "🧠 engine" : t}
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
                  { k: "waSessions", label: "WA sessions live", emoji: "🟢", hint: "How many users (including you) currently have a live, linked WhatsApp session sending through the app right now." },
                  { k: "repliesToday", label: "Shop replies (24h)", emoji: "📥", hint: "Messages rental shops sent back to your agents in the last 24 hours." },
                  { k: "offersToday", label: "Offers landed (24h)", emoji: "🤝", hint: "Real prices captured from shop replies in the last 24 hours." },
                  { k: "queuedMessages", label: "Queued messages", emoji: "🕘", hint: "Messages the anti-ban engine is holding to send later (shop closed, rate limit, human pacing). Tap below to see and flush them." },
                  { k: "openIssues", label: "Open issues", emoji: "🐛", hint: "Feedback the AI triaged as a genuine bug/usability issue that is still open." },
                ].map((s) => (
                  <div key={s.k} title={s.hint} className="surface rounded-2xl p-3 text-center">
                    <div className="text-xl font-extrabold text-strong">
                      {s.emoji} {command.stats[s.k] ?? 0}
                    </div>
                    <div className="text-[10px] font-bold text-faint">{s.label} ⓘ</div>
                  </div>
                ))}
              </div>

              {/* Queued messages now live in the user-facing find-deals page
                  (item #2) - every traveller manages their own queue there. */}

              {/* Popular-questions manager: add (AI or by hand) / remove (#18) */}
              <FaqManager />

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

      {loaded && tab === "engine" && <EngineInspectorPanel />}

      {loaded && tab === "ops" && isOwner && <OpsCenterPanel />}

      {loaded && tab === "agents" && (
        <div className="space-y-3">

          {/* The owner's full-control agent pipeline: stages, custom agents,
              edge rules and live decision traces (replaces the old funnel map
              + core-prompts editors). */}
          <OrchestratorPanel isOwner={isOwner} />
        </div>
      )}

      {/* Market floors - moved to Analytics (item #16), foldable */}
      {loaded && tab === "analytics" && (
        <div className="mb-3 space-y-3">
          <details className="surface rounded-blob p-4">
            <summary className="flex cursor-pointer list-none items-center justify-between">
              <span className="text-[13px] font-extrabold text-strong">
                📉 Cheapest-price table (market floors)
              </span>
              <span className="rounded-full bg-brandblue-soft px-2 py-0.5 text-[10px] font-extrabold text-brandblue">
                {floors.length} rows ▾
              </span>
            </summary>
            <div className="mt-2">
            <p className="mb-2 text-[11px] text-faint">
              The lowest realistic daily price per area and vehicle bucket, from
              live web research (first search in an area triggers it), refreshed
              every 3 weeks; your manual edits always win. The bargaining agent
              never asks below these floors.
            </p>
            <div className="mb-2 flex items-start gap-2">
              <div className="flex-1">
                <PlaceAutocomplete
                  placeholder="Research an area now, e.g. koh samui, thailand"
                  value={floorRegion}
                  onText={setFloorRegion}
                />
              </div>
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
              🌐 <b>Autonomous:</b> a new area is researched from the live web and
              saved the first time a user searches there (or when you research it
              above), then refreshed every 3 weeks. We store ONE row per area +
              vehicle bucket - never per town - so the database stays small and
              every later visit to that area is instant. Prices are always in the
              area&apos;s <b>local currency</b>. 👑 = your manual edit (survives
              refreshes), 🌐 = web research, 🤖 = model estimate.
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
                                <td className="p-1.5">{f.source === "owner" ? "👑" : f.source === "web" ? "🌐" : "🤖"}</td>
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
          </details>
        </div>
      )}

      {/* Anti-Ban engine + Sponsored shops - moved to Command (item #16), foldable */}
      {loaded && tab === "command" && (
        <div className="mt-3 space-y-3">
          <details className="surface rounded-blob p-4">
            <summary className="cursor-pointer list-none text-[13px] font-extrabold text-strong">
              🛡 Anti-Ban engine <span className="text-[10px] font-bold text-faint">▾</span>
            </summary>
            <div className="mt-2">
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
                                  loadCommand();
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
                              aria-label={`What is ${h?.label ?? k.replace(/_/g, " ")}?`}
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
                          // Keyed to the EFFECTIVE value: after a save (or a
                          // rejection) the field re-mounts showing what the
                          // engine actually holds, so the panel can never
                          // display "on" while the engine holds false.
                          key={`${k}:${String(v)}`}
                          defaultValue={String(v)}
                          onBlur={async (e) => {
                            const val = e.target.value.trim();
                            if (!val || val === String(v)) return;
                            const r = await (
                              await fetch("/api/admin/wa-security", {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ key: k, value: val }),
                              })
                            ).json();
                            if (r.error) {
                              setWaPolicyErr({ key: k, error: String(r.error) });
                              e.target.value = String(v);
                              return;
                            }
                            setWaPolicyErr(null);
                            if (r.policies) setWaSec({ ...waSec, policies: r.policies });
                          }}
                          className="mt-0.5 w-full rounded border border-line bg-card p-1 text-[12px] font-extrabold text-strong"
                        />
                        {waPolicyErr?.key === k && (
                          <div className="mt-1 text-[10px] font-extrabold text-brandred">
                            {waPolicyErr.error}
                          </div>
                        )}
                        {waHelp === k && h && (
                          <div className="absolute left-0 top-full z-20 mt-1 w-56 max-w-[calc(100vw-2rem)] rounded-xl border-2 border-brandblue bg-card p-2.5 text-[11px] shadow-xl">
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
          </details>

          {/* Sponsored shops: paid placements with the glowing Recommended card */}
          <details className="surface rounded-blob p-4">
            <summary className="flex cursor-pointer list-none items-center justify-between">
              <span className="text-[13px] font-extrabold text-strong">⭐ Sponsored shops</span>
              <span className="rounded-full bg-brandblue-soft px-2 py-0.5 text-[10px] font-extrabold text-brandblue">
                {sponsors.filter((s) => s.active).length} live ▾
              </span>
            </summary>
            <div className="mt-2">
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
          </details>
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
          {/* Live service health with 10-minute auto-refresh (item #12) */}
          <HealthPanel />

          {/* WA doctor: one-tap inbound incident tracer + webhook re-arm */}
          <WaDoctorCard />

          <div
            className={`rounded-2xl border-2 p-3 text-[12px] font-bold ${
              persistent === null
                ? "border-line bg-card2 text-soft"
                : persistent
                  ? "border-savings bg-savings-soft text-savings"
                  : "border-brandyellow bg-brandyellow-soft text-[#8a6100] dark:text-brandyellow"
            }`}
          >
            <Icon name="shield" className="mr-1 inline h-4 w-4" />
            {persistent === null
              ? "Checking the key vault connection…"
              : persistent
                ? "Persistence is on - edits are encrypted, saved to Supabase, applied within ~30s, and survive restarts."
                : "Persistence is OFF: Supabase is not connected, so anything you paste here resets on the next deploy and is NOT shared across instances. Set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in your host env (GCP Secret Manager), run schema.sql, then redeploy - your saved keys are still in Supabase and reappear once it reconnects."}
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
              <button
                onClick={() => runDiag("email")}
                disabled={diagBusy !== null}
                className="btn btn-ghost btn-sm flex-1 rounded-xl text-[12px] disabled:opacity-60"
              >
                {diagBusy === "email" ? <LoadingDots label="Sending" /> : "Send live test email"}
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
                  {p.model && (
                    <div className="mt-0.5 font-mono text-[10px] text-faint">{p.model}</div>
                  )}
                  <div className="mt-0.5 text-[11px] text-soft">
                    Used here: {p.tokensUsed.toLocaleString()} tokens · {p.requests} calls
                    {p.failures > 0 ? ` · ${p.failures} failovers` : ""}
                  </div>
                  {p.cadence && p.cadence !== "none" && (
                    <div className="text-[11px] text-soft">
                      This {p.cadence}: {Number(p.usedThisCycle ?? 0).toLocaleString()} tokens used
                      {" · "}
                      <span className="text-faint">
                        free tier resets {p.cadence === "day" ? "daily" : "monthly"}
                      </span>
                    </div>
                  )}
                  <div className="text-[11px] text-faint">
                    Remaining:{" "}
                    {p.remaining ??
                      (p.cadenceNote ?? "this provider does not expose remaining quota")}
                  </div>
                </button>
              ))}
            </div>
            {isOwner && (
              <div className="mt-3 border-t border-line pt-3">
                <button
                  onClick={runDistill}
                  disabled={distillBusy}
                  className="btn btn-sm btn-ghost w-full rounded-xl border border-line py-2 text-[12px] font-extrabold disabled:opacity-50"
                >
                  {distillBusy ? "Distilling…" : "🧪 Distill now (teach the free models)"}
                </button>
                <p className="mt-1 text-[10px] text-faint">
                  Mines winning negotiation turns and distils them (DeepSeek-preferred) into few-shot
                  tactics the free models reuse next turn. Runs ~$0.
                </p>
                {distillMsg && <p className="mt-1 text-[11px] font-bold text-soft">{distillMsg}</p>}
              </div>
            )}
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
              const isFirstOfScope = k.scope !== lastScope;
              lastScope = k.scope;
              const collapsed = collapsedScopes[k.scope];
              const inScope = sorted.filter((x) => x.scope === k.scope);
              const doneCount = inScope.filter((x) => x.configured).length;
              const header = isFirstOfScope ? (
                <button
                  key={`hdr-${k.scope}`}
                  onClick={() =>
                    setCollapsedScopes((s) => ({ ...s, [k.scope]: !s[k.scope] }))
                  }
                  className="mt-3 flex w-full items-center gap-2 rounded-xl bg-card2 px-3 py-2 text-left"
                >
                  <span className="text-[10px] text-faint">{collapsed ? "▶" : "▼"}</span>
                  <span className="flex-1 text-[11px] font-extrabold uppercase tracking-wide text-strong">
                    {groupLabel[k.scope] ?? k.scope}
                  </span>
                  <span className="rounded-full bg-card px-2 py-0.5 text-[9px] font-bold text-faint">
                    {doneCount}/{inScope.length} set
                  </span>
                </button>
              ) : null;
              // Collapsed group: show only its header row.
              if (collapsed) {
                return header ? <div key={k.name}>{header}</div> : null;
              }
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
          {/* Private-beta invite list (owner only) */}
          {isOwner && <BetaManager />}

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
              {/* User-visible reply thread (distinct from the internal note
                  above): what the reporter reads and can answer in Your reports. */}
              <AdminReplyThread
                report={f}
                onReplied={(reply) =>
                  setFeedbackRows((rows) =>
                    rows.map((r) =>
                      r.id === f.id ? { ...r, replies: [...(r.replies ?? []), reply] } : r
                    )
                  )
                }
              />
              {/* Delete this report for good (spam / resolved noise) */}
              <div className="mt-1.5 flex justify-end">
                <button
                  onClick={async () => {
                    if (!confirm("Delete this feedback permanently? This cannot be undone.")) return;
                    const res = await fetch(`/api/admin/feedback?id=${f.id}`, { method: "DELETE" });
                    if (res.ok) {
                      setFeedbackRows((rows) => rows.filter((r) => r.id !== f.id));
                    }
                  }}
                  className="btn btn-sm rounded-lg border-2 border-line px-2.5 py-0.5 text-[10px] font-extrabold text-brandred hover:bg-brandred-soft"
                >
                  🗑 Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {loaded && tab === "billing" && (
        <div className="space-y-3">
          <div
            className={`rounded-2xl border-2 p-3 text-[12px] font-bold ${
              billingOn
                ? "border-savings bg-savings-soft text-savings"
                : "border-brandyellow bg-brandyellow-soft text-[#8a6100] dark:text-brandyellow"
            }`}
          >
            <Icon name="card" className="mr-1 inline h-4 w-4" />
            {billingOn
              ? "Payments are connected. Users see the 80% launch offer (billed every 3 months) via the upgrade chip and at signup."
              : "Billing preview. Connect PayPal (no merchant-approval gate, $0/month, pays out to Israeli bank accounts) - add the PAYPAL_* keys in the Keys tab."}
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

// Compact label/value stat used in the Intel expandable detail grid.
function Stat({
  label,
  value,
  good,
  bad,
}: {
  label: string;
  value: string;
  good?: boolean;
  bad?: boolean;
}) {
  return (
    <div className="rounded-lg bg-card p-1.5">
      <div className="text-[8px] font-bold uppercase tracking-wide text-faint">{label}</div>
      <div
        className={`text-[11px] font-extrabold ${
          good ? "text-savings" : bad ? "text-brandred" : "text-strong"
        }`}
      >
        {value}
      </div>
    </div>
  );
}


// FAQ manager (#18): owner adds popular questions (AI-written or typed) and
// removes them. Travellers see them as an expandable section in the app.
function FaqManager() {
  const [items, setItems] = useState<{ id: string; q: string; a: string }[]>([]);
  const [q, setQ] = useState("");
  const [a, setA] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function load() {
    const d = await (await fetch("/api/faq")).json();
    setItems(d.items ?? []);
  }
  useEffect(() => {
    load();
  }, []);

  async function add(generate: boolean) {
    if (!q.trim()) return;
    setBusy(true);
    setMsg(null);
    try {
      const d = await (
        await fetch("/api/faq", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ question: q.trim(), answer: a.trim(), generate }),
        })
      ).json();
      if (d.items) {
        setItems(d.items);
        setQ("");
        setA("");
      } else setMsg(d.error ?? "Could not add.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    const d = await (await fetch(`/api/faq?id=${id}`, { method: "DELETE" })).json();
    if (d.items) setItems(d.items);
  }

  return (
    <div className="surface rounded-blob p-4">
      <div className="mb-1 text-[13px] font-extrabold text-strong">💬 Popular questions</div>
      <p className="mb-2 text-[11px] text-faint">
        Shown to travellers on the home screen. Add a question and either write the
        answer or let the AI write it. Remove any at any time.
      </p>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Question, e.g. Do I need an international licence?"
        className="mb-1.5 w-full rounded-xl border-2 border-line bg-card p-2 text-[12px] text-strong focus:border-brandblue focus:outline-none"
      />
      <textarea
        value={a}
        onChange={(e) => setA(e.target.value)}
        rows={2}
        placeholder="Answer (leave empty and tap 'AI write' to generate one)"
        className="mb-1.5 w-full rounded-xl border-2 border-line bg-card p-2 text-[12px] text-strong focus:border-brandblue focus:outline-none"
      />
      {msg && <p className="mb-1.5 text-[11px] font-bold text-brandred">{msg}</p>}
      <div className="flex gap-2">
        <button
          onClick={() => add(false)}
          disabled={busy || !q.trim() || !a.trim()}
          className="btn btn-primary btn-sm flex-1 rounded-xl text-[12px] disabled:opacity-50"
        >
          {busy ? <LoadingDots light /> : "Add"}
        </button>
        <button
          onClick={() => add(true)}
          disabled={busy || !q.trim()}
          className="btn btn-sm flex-1 rounded-xl border-2 border-line text-[12px] font-extrabold text-brandblue disabled:opacity-50"
        >
          🤖 AI write
        </button>
      </div>
      <div className="mt-3 space-y-1.5">
        {items.map((it) => (
          <div key={it.id} className="rounded-xl bg-card2 p-2.5">
            <div className="flex items-start justify-between gap-2">
              <div className="text-[12px] font-bold text-strong">{it.q}</div>
              <button onClick={() => remove(it.id)} className="shrink-0 text-[11px] font-bold text-brandred">
                Remove
              </button>
            </div>
            <div className="mt-0.5 text-[11px] text-soft">{it.a}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// Private-beta invite manager (owner only). Paste the 25 tester emails with a
// plan each; the app blocks everyone else at login. Stored in Supabase config,
// applied instantly with no redeploy.
function BetaManager() {
  const [text, setText] = useState("");
  const [counts, setCounts] = useState<{ total: number; free: number; pro: number; ultra: number } | null>(null);
  const [lock, setLock] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [testMode, setTestMode] = useState(false);
  const [testBusy, setTestBusy] = useState(false);

  async function load() {
    const d = await (await fetch("/api/admin/beta")).json();
    setLock(Boolean(d.lockEnabled));
    setCounts(d.counts ?? null);
    setText(
      (d.entries ?? [])
        .map(
          (e: { email: string; plan: string; test?: boolean }) =>
            `${e.email}, ${e.plan}${e.test ? ", test" : ""}`
        )
        .join("\n")
    );
    fetch("/api/config/public")
      .then((r) => r.json())
      .then((p) => setTestMode(Boolean(p.testMode)))
      .catch(() => {});
  }
  useEffect(() => {
    load();
  }, []);

  async function toggleTestMode() {
    setTestBusy(true);
    try {
      await fetch("/api/admin/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "TEST_MODE", value: testMode ? "off" : "on" }),
      });
      setTestMode((v) => !v);
    } finally {
      setTestBusy(false);
    }
  }

  async function save() {
    setBusy(true);
    setMsg(null);
    const entries = text
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [email, plan, flag] = line.split(/[,:|]/).map((x) => x.trim());
        return {
          email: (email ?? "").toLowerCase(),
          plan: (plan ?? "free").toLowerCase(),
          test: (flag ?? "").toLowerCase() === "test",
        };
      })
      .filter((e) => e.email.includes("@"));
    try {
      const d = await (
        await fetch("/api/admin/beta", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ entries }),
        })
      ).json();
      if (d.entries) {
        setMsg(`Saved - ${d.entries.length} account(s) can log in (incl. you).`);
        await load();
      } else setMsg(d.error ?? "Could not save.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="surface rounded-blob border-2 !border-brandblue p-4">
      <div className="mb-1 flex items-center justify-between">
        <div className="text-[13px] font-extrabold text-strong">🔒 Private beta - invite list</div>
        <span
          className={`rounded-full px-2 py-0.5 text-[10px] font-extrabold ${
            lock ? "bg-savings-soft text-savings" : "bg-brandred-soft text-brandred"
          }`}
        >
          {lock ? "LOCK ON" : "LOCK OFF"}
        </span>
      </div>
      <p className="mb-2 text-[11px] text-faint">
        Only these accounts (plus you) can log in - everyone else is blocked at the
        door. One per line: <span className="font-mono">email, plan</span> where plan
        is free / pro / ultra - append <span className="font-mono">, test</span> to
        make someone a TEST USER. Up to 25 testers. Applies instantly, no redeploy.
      </p>
      {/* Global Test Mode switch: test users ride Ultra free + sandbox billing */}
      <div className="mb-2 flex items-center justify-between rounded-xl bg-card2 p-2.5">
        <div>
          <div className="text-[12px] font-extrabold text-strong">🧪 Test Mode</div>
          <div className="text-[10px] text-faint">
            ON: testers marked &quot;test&quot; get Ultra free, checkout applies plans
            instantly (no charge), a banner shows app-wide. OFF: fully live.
          </div>
        </div>
        <button
          onClick={toggleTestMode}
          disabled={testBusy}
          className={`btn btn-sm rounded-full px-4 py-1.5 text-[11px] font-extrabold disabled:opacity-50 ${
            testMode ? "bg-brandyellow text-[#4a3300]" : "btn-ghost border border-line"
          }`}
        >
          {testBusy ? "..." : testMode ? "ON - go live" : "OFF - enable"}
        </button>
      </div>
      {counts && (
        <div className="mb-2 flex flex-wrap gap-1.5 text-[10px] font-bold">
          <span className="rounded-full bg-card2 px-2 py-0.5 text-faint">{counts.total} total</span>
          <span className="rounded-full bg-card2 px-2 py-0.5 text-faint">{counts.free} free</span>
          <span className="rounded-full bg-card2 px-2 py-0.5 text-brandblue">{counts.pro} pro</span>
          <span className="rounded-full bg-card2 px-2 py-0.5 text-savings">{counts.ultra} ultra</span>
        </div>
      )}
      <textarea
        rows={8}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={"tester1@gmail.com, free\ntester2@gmail.com, pro\ntester3@gmail.com, ultra"}
        className="w-full rounded-xl border-2 border-line bg-card p-2 font-mono text-[12px] text-strong focus:border-brandblue focus:outline-none"
      />
      {msg && <p className="mt-1.5 text-[11px] font-bold text-savings">{msg}</p>}
      <button
        onClick={save}
        disabled={busy}
        className="btn btn-primary mt-2 w-full rounded-xl py-2.5 text-[13px] disabled:opacity-60"
      >
        {busy ? <LoadingDots light /> : "Save invite list"}
      </button>
      {!lock && (
        <p className="mt-1.5 text-[10px] font-bold text-brandred">
          Lock is OFF (BETA_LOCK=off) - anyone can sign up. Set BETA_LOCK=on in the
          host env to enforce this list.
        </p>
      )}
    </div>
  );
}
