"use client";

import { useEffect, useState } from "react";
import { Icon } from "@/components/icons";
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
  status: "active" | "blocked";
  addedAt: number;
  lastSeen: number;
}

export default function AdminPage() {
  const [authorized, setAuthorized] = useState<boolean | null>(null);
  const [tab, setTab] = useState<"analytics" | "keys" | "users">("analytics");
  const [analytics, setAnalytics] = useState<AnalyticsSnapshot | null>(null);
  const [keys, setKeys] = useState<KeyInfo[]>([]);
  const [users, setUsers] = useState<UserRecord[]>([]);
  const [editing, setEditing] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<string | null>(null);
  const [persistent, setPersistent] = useState(false);

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
      setUsers((await (await fetch("/api/admin/users")).json()).users ?? []);
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
      setTimeout(() => setSaved(null), 1500);
    }
  }

  async function setUserStatus(email: string, status: "active" | "blocked") {
    const res = await fetch("/api/admin/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, status }),
    });
    setUsers((await res.json()).users ?? []);
  }

  if (authorized === null) {
    return (
      <Shell>
        <div className="mt-20 text-center text-slate-500">Checking access…</div>
      </Shell>
    );
  }
  if (!authorized) {
    return (
      <Shell>
        <div className="mt-20 text-center">
          <Icon name="lock" className="mx-auto mb-3 h-10 w-10 text-slate-600" />
          <p className="text-slate-300">
            This workspace is restricted to administrators.
          </p>
          <a href="/login" className="mt-3 inline-block text-savings underline">
            Sign in with an admin email
          </a>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="surface-strong mb-4 flex gap-1 rounded-xl p-1">
        {(["analytics", "keys", "users"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex-1 rounded-lg py-2 text-[13px] font-medium capitalize transition ${
              tab === t ? "bg-savings text-ink" : "text-slate-300 hover:bg-slate-700/30"
            }`}
          >
            {t === "keys" ? "Key vault" : t === "users" ? "User access" : "Analytics"}
          </button>
        ))}
      </div>

      {tab === "analytics" && analytics && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <Metric label="Search runs" value={String(analytics.totalRuns)} />
            <Metric label="Offers pulled" value={String(analytics.totalOffers)} />
            <Metric
              label="Avg discount"
              value={`${analytics.avgDiscountPct}%`}
              accent
            />
            <Metric
              label="Avg cycle"
              value={`${analytics.avgCycleSeconds}s`}
            />
          </div>
          <div className="surface rounded-2xl p-4">
            <div className="mb-3 flex items-center gap-1.5 text-sm font-semibold text-white">
              <Icon name="spark" className="h-4 w-4 text-savings" /> Agent memory
              — negotiation playbook
            </div>
            <p className="mb-3 text-[12px] text-slate-500">
              Best performer:{" "}
              <span className="text-savings-bright">
                {analytics.bestTactic ?? "—"}
              </span>
            </p>
            <div className="space-y-2">
              {analytics.tactics.map((t) => {
                const winRate = t.uses ? Math.round((t.wins / t.uses) * 100) : 0;
                return (
                  <div key={t.id} className="rounded-xl bg-ink/50 p-3">
                    <div className="flex items-center justify-between">
                      <span className="text-[13px] font-medium text-white">
                        {t.label}
                      </span>
                      <span className="text-[11px] text-slate-400">
                        {t.wins}/{t.uses} wins · {t.avgDiscountPct}% avg cut
                      </span>
                    </div>
                    <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-slate-700/40">
                      <div
                        className="h-full rounded-full bg-savings transition-all"
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
            className={`rounded-xl border p-3 text-[12px] ${
              persistent
                ? "border-savings/30 bg-savings/10 text-savings-bright"
                : "border-amber-500/30 bg-amber-500/10 text-amber-200"
            }`}
          >
            <Icon name="shield" className="mr-1 inline h-4 w-4" />
            {persistent ? (
              <>
                Persistence is <b>on</b> — edits are encrypted and saved to
                Supabase, take effect within ~30s, and survive restarts. Secret
                values are never sent to the browser (masked fingerprint only).
              </>
            ) : (
              <>
                <b>Demo persistence:</b> Supabase isn&apos;t connected, so edits
                apply to this instance only and reset on restart. Set the
                Supabase env vars to make the vault durable. Secrets are never
                sent to the browser.
              </>
            )}
          </div>
          {keys.map((k) => (
            <div key={k.name} className="surface rounded-2xl p-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-[13px] font-semibold text-white">
                    {k.label}
                  </div>
                  <div className="font-mono text-[11px] text-slate-500">
                    {k.name}
                  </div>
                </div>
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                    k.configured
                      ? "bg-savings/15 text-savings-bright"
                      : "bg-slate-600/20 text-slate-400"
                  }`}
                >
                  {k.configured ? "configured" : "missing"}
                </span>
              </div>
              <div className="mt-2 font-mono text-[12px] text-slate-400">
                {k.masked}
              </div>
              {k.editable ? (
                <div className="mt-2 flex gap-2">
                  <input
                    type="password"
                    placeholder="Set / rotate value"
                    value={editing[k.name] ?? ""}
                    onChange={(e) =>
                      setEditing((ed) => ({ ...ed, [k.name]: e.target.value }))
                    }
                    className="flex-1 rounded-lg border border-slate-700/50 bg-ink/60 p-2 text-[12px] text-white focus:border-savings/50 focus:outline-none"
                  />
                  <button
                    onClick={() => saveKey(k.name)}
                    className="rounded-lg bg-savings px-3 py-2 text-[12px] font-semibold text-ink hover:bg-savings-bright"
                  >
                    {saved === k.name ? "Saved" : "Apply"}
                  </button>
                </div>
              ) : (
                <div className="mt-2 text-[11px] text-slate-500">
                  Bootstrap secret — set via host environment variables only.
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {tab === "users" && (
        <div className="space-y-2">
          {users.length === 0 && (
            <div className="surface rounded-2xl p-4 text-center text-[12px] text-slate-500">
              No users have signed in yet.
            </div>
          )}
          {users.map((u) => (
            <div
              key={u.email}
              className="surface flex items-center justify-between rounded-2xl p-3"
            >
              <div className="min-w-0">
                <div className="truncate text-[13px] text-white">{u.email}</div>
                <div className="text-[11px] text-slate-500">
                  last seen {new Date(u.lastSeen).toLocaleString()}
                </div>
              </div>
              <button
                onClick={() =>
                  setUserStatus(u.email, u.status === "active" ? "blocked" : "active")
                }
                className={`rounded-lg px-3 py-1.5 text-[12px] font-semibold ${
                  u.status === "active"
                    ? "bg-rose-500/15 text-rose-300 hover:bg-rose-500/25"
                    : "bg-savings/15 text-savings-bright hover:bg-savings/25"
                }`}
              >
                {u.status === "active" ? "Block" : "Unblock"}
              </button>
            </div>
          ))}
        </div>
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto min-h-screen max-w-md px-4 pb-16 pt-5 sm:max-w-lg">
      <header className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-savings/15">
            <Icon name="shield" className="h-5 w-5 text-savings-bright" />
          </div>
          <div>
            <h1 className="text-lg font-extrabold leading-none text-white">
              Management Workspace
            </h1>
            <p className="text-[11px] text-slate-500">WheelDeal admin</p>
          </div>
        </div>
        <a
          href="/"
          className="rounded-lg border border-slate-700/50 px-2.5 py-1.5 text-[12px] text-slate-300 hover:bg-slate-700/30"
        >
          ← App
        </a>
      </header>
      {children}
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
    <div className="surface rounded-2xl p-4 text-center">
      <div className="text-[10px] uppercase tracking-wide text-slate-500">
        {label}
      </div>
      <div
        className={`mt-1 text-xl font-bold ${
          accent ? "text-savings-bright" : "text-white"
        }`}
      >
        {value}
      </div>
    </div>
  );
}
