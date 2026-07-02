"use client";

import { useEffect, useState } from "react";
import { Icon } from "@/components/icons";
import { BrandMark } from "@/components/BrandMark";
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
  provider: string;
  addedAt: number;
  lastSeen: number;
}

export default function AdminPage() {
  const [authorized, setAuthorized] = useState<boolean | null>(null);
  const [tab, setTab] = useState<"analytics" | "keys" | "users" | "billing">("analytics");
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
  const [trainingCount, setTrainingCount] = useState(0);
  const [trainMsg, setTrainMsg] = useState<string | null>(null);

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
    })().catch(() => setAuthorized(false));
  }, []);

  async function saveKey(name: string) {
    const value = editing[name] ?? "";
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
    const res = await fetch("/api/admin/training", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: training }),
    });
    const data = await res.json();
    if (res.ok) {
      setTraining("");
      setTrainingCount((data.examples ?? []).length);
      setTrainMsg("Learned ✓ - the bargaining agents will use this style.");
    } else {
      setTrainMsg(data.error ?? "Could not save.");
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
        {(["analytics", "keys", "users", "billing"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`btn btn-sm flex-1 rounded-xl py-2 text-[12px] font-extrabold capitalize ${
              tab === t ? "bg-brandblue text-white" : "text-soft hover:bg-card2"
            }`}
          >
            {t}
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
            {trainMsg && (
              <p className="mt-1 text-[12px] font-bold text-savings">{trainMsg}</p>
            )}
            <button
              onClick={teach}
              disabled={training.trim().length < 20}
              className="btn btn-primary mt-2 w-full rounded-2xl py-2.5 text-[13px] disabled:opacity-60"
            >
              Teach the agents
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
                    className="btn btn-primary btn-sm rounded-xl px-3 text-[12px]"
                  >
                    {saved === k.name ? "Saved" : "Apply"}
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

          {users.length === 0 && (
            <div className="surface rounded-blob p-4 text-center text-[12px] text-faint">
              No users have signed in on this instance yet.
            </div>
          )}
          {users.map((u) => (
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
              ? "Stripe is connected. Users see the 80% launch offer (billed every 3 months) via the upgrade chip and at signup."
              : "Billing preview. Add STRIPE_SECRET_KEY in Keys to enable real Checkout. Users will see the 80% launch offer chip."}
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
    <main className="mx-auto min-h-[100dvh] max-w-md pb-16 sm:max-w-lg">
      <div className="topbar">
        <div className="flex items-center justify-between px-4 pb-2.5">
          <div className="flex items-center gap-2">
            <BrandMark size={30} />
            <div>
              <h1 className="font-display text-lg font-extrabold leading-none text-strong">
                Management
              </h1>
              <p className="text-[10px] font-bold text-faint">WheelDeal workspace</p>
            </div>
          </div>
          <a href="/" className="btn btn-sm btn-ghost rounded-xl px-3 py-1.5 text-[12px]">
            ← App
          </a>
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
