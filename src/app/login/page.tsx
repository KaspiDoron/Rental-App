"use client";

import { useState } from "react";
import { Icon } from "@/components/icons";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [error, setError] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setStatus("loading");
    setError("");
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    const data = await res.json();
    if (!res.ok) {
      setStatus("error");
      setError(data.error ?? "Sign-in failed.");
      return;
    }
    window.location.href = data.session?.isAdmin ? "/admin" : "/";
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-5">
      <div className="mb-6 text-center">
        <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-savings/15">
          <Icon name="bolt" className="h-6 w-6 text-savings-bright" />
        </div>
        <h1 className="text-2xl font-extrabold text-white">
          Wheel<span className="text-savings-bright">Deal</span>
        </h1>
        <p className="mt-1 text-sm text-slate-400">
          Passwordless sign-in. Enter your email to start saving.
        </p>
      </div>

      <form onSubmit={submit} className="surface rounded-2xl p-5">
        <label className="text-[12px] font-medium text-slate-300">Email</label>
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          className="mt-1 w-full rounded-xl border border-slate-700/50 bg-ink/60 p-3 text-sm text-white placeholder:text-slate-600 focus:border-savings/50 focus:outline-none"
        />
        {status === "error" && (
          <p className="mt-2 text-[12px] text-rose-300">{error}</p>
        )}
        <button
          type="submit"
          disabled={status === "loading"}
          className="mt-3 w-full rounded-xl bg-savings py-3 text-sm font-bold text-ink hover:bg-savings-bright disabled:opacity-60"
        >
          {status === "loading" ? "Signing in…" : "Continue"}
        </button>
        <p className="mt-3 flex items-center gap-1.5 text-[11px] text-slate-500">
          <Icon name="lock" className="h-3.5 w-3.5" />
          We issue a signed, http-only session. Admin access is granted by
          allowlist only.
        </p>
      </form>

      <a href="/" className="mt-4 text-center text-[12px] text-slate-500 hover:text-slate-300">
        ← Back to search
      </a>
    </main>
  );
}
