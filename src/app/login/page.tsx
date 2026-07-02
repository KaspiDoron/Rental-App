"use client";

import { useEffect, useRef, useState } from "react";
import { BrandMark } from "@/components/BrandMark";
import { TermsModal } from "@/components/TermsModal";
import { PlanCard, type PlanView } from "@/components/UpgradeSheet";
import { Icon } from "@/components/icons";

declare global {
  interface Window {
    google?: any;
  }
}

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [acceptTerms, setAcceptTerms] = useState(false);
  const [needsSignup, setNeedsSignup] = useState(false);
  const [googleCredential, setGoogleCredential] = useState<string | null>(null);
  const [googleName, setGoogleName] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [error, setError] = useState("");
  const [showTerms, setShowTerms] = useState(false);
  const [step, setStep] = useState<"auth" | "plans">("auth");
  const [plans, setPlans] = useState<PlanView[]>([]);
  const googleDiv = useRef<HTMLDivElement>(null);

  // Google OAuth (Google Identity Services) - renders only when a client id
  // is configured in the Key Vault / env.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/config/public");
        const { googleClientId } = await res.json();
        if (!googleClientId || cancelled) return;
        await new Promise<void>((resolve, reject) => {
          if (window.google?.accounts) return resolve();
          const s = document.createElement("script");
          s.src = "https://accounts.google.com/gsi/client";
          s.onload = () => resolve();
          s.onerror = reject;
          document.head.appendChild(s);
        });
        if (cancelled || !googleDiv.current) return;
        window.google.accounts.id.initialize({
          client_id: googleClientId,
          callback: (resp: { credential: string }) => submitGoogle(resp.credential),
        });
        window.google.accounts.id.renderButton(googleDiv.current, {
          theme: "outline",
          size: "large",
          width: 320,
          shape: "pill",
          text: "continue_with",
        });
      } catch {
        /* Google button simply doesn't render */
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function finish(session: any) {
    // Show the launch-offer plan card once during signup, then enter the app.
    try {
      const res = await fetch("/api/billing/checkout");
      const d = await res.json();
      const paid = (d.plans ?? []).filter((p: PlanView) => p.amount > 0);
      if (paid.length && session?.role === "user") {
        setPlans(paid);
        setStep("plans");
        return;
      }
    } catch {
      /* skip plans */
    }
    enterApp(session);
  }

  function enterApp(session: any) {
    window.location.href = session?.role && session.role !== "user" ? "/admin" : "/";
  }

  async function submitEmail(e: React.FormEvent) {
    e.preventDefault();
    setStatus("loading");
    setError("");
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, phone, acceptTerms }),
    });
    const data = await res.json();
    if (data.needsSignup && !data.error) {
      setNeedsSignup(true);
      setStatus("idle");
      return;
    }
    if (!res.ok) {
      setStatus("error");
      setError(data.error ?? "Sign-in failed.");
      return;
    }
    await finish(data.session);
  }

  async function submitGoogle(credential: string, withProfile = false) {
    setStatus("loading");
    setError("");
    const res = await fetch("/api/auth/google", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        withProfile ? { credential, phone, acceptTerms } : { credential }
      ),
    });
    const data = await res.json();
    if (data.needsSignup) {
      setGoogleCredential(credential);
      setGoogleName(data.name ?? "");
      setEmail(data.email ?? "");
      setNeedsSignup(true);
      setStatus("idle");
      return;
    }
    if (!res.ok) {
      setStatus("error");
      setError(data.error ?? "Google sign-in failed.");
      return;
    }
    await finish(data.session);
  }

  async function completeGoogleSignup(e: React.FormEvent) {
    e.preventDefault();
    if (!googleCredential) return;
    await submitGoogle(googleCredential, true);
  }

  if (step === "plans") {
    return (
      <main className="mx-auto flex min-h-[100dvh] max-w-md flex-col justify-center px-5 pb-safe pt-safe">
        <div className="mb-4 text-center">
          <h1 className="font-display text-2xl font-extrabold text-strong">
            Welcome aboard! 🎉
          </h1>
          <p className="mt-1 text-sm font-bold text-brandred">
            One-time opening offer: 80% off Pro, billed every 3 months
          </p>
        </div>
        <div className="space-y-3">
          {plans.map((p) => (
            <PlanCard
              key={p.id}
              plan={p}
              onSubscribe={async (id) => {
                const res = await fetch("/api/billing/checkout", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ planId: id }),
                });
                const d = await res.json();
                if (d.url) window.location.href = d.url;
                else enterApp({ role: "user" });
              }}
            />
          ))}
        </div>
        <button
          onClick={() => enterApp({ role: "user" })}
          className="btn btn-ghost mx-auto mt-4 rounded-2xl px-6 py-2.5 text-sm"
        >
          Maybe later - start saving
        </button>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-[100dvh] max-w-md flex-col justify-center px-5 pb-safe pt-safe">
      <div className="mb-6 text-center">
        <div className="mx-auto mb-2 w-fit">
          <BrandMark size={84} />
        </div>
        <h1 className="font-display text-3xl font-extrabold text-strong">
          Wheel<span className="text-brandblue">Deal</span>
        </h1>
        <p className="mt-1 text-sm text-soft">
          {needsSignup
            ? "One quick step and you're in."
            : "Sign in or create your account to start saving."}
        </p>
      </div>

      <form
        onSubmit={googleCredential ? completeGoogleSignup : submitEmail}
        className="surface rounded-blob p-5"
      >
        {googleCredential ? (
          <div className="mb-3 flex items-center gap-2 rounded-2xl bg-brandblue-soft p-3 text-[13px] font-bold text-brandblue">
            <Icon name="check" className="h-4 w-4" />
            Google verified{googleName ? `: ${googleName}` : ""} ({email})
          </div>
        ) : (
          <>
            <label className="text-[12px] font-extrabold text-soft">Email</label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="mt-1 w-full rounded-2xl border-2 border-line bg-card p-3 text-sm text-strong placeholder:text-faint focus:border-brandblue focus:outline-none"
            />
          </>
        )}

        {needsSignup && (
          <>
            <label className="mt-3 block text-[12px] font-extrabold text-soft">
              Phone number
            </label>
            <input
              type="tel"
              required
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+62 812 345 678"
              className="mt-1 w-full rounded-2xl border-2 border-line bg-card p-3 text-sm text-strong placeholder:text-faint focus:border-brandblue focus:outline-none"
            />
            <label className="mt-3 flex items-start gap-2.5 text-[13px] text-soft">
              <input
                type="checkbox"
                checked={acceptTerms}
                onChange={(e) => setAcceptTerms(e.target.checked)}
                className="mt-0.5 h-5 w-5 accent-[var(--blue)]"
                required
              />
              <span>
                I agree to the{" "}
                <button
                  type="button"
                  onClick={() => setShowTerms(true)}
                  className="font-extrabold text-brandblue underline"
                >
                  Terms of Use
                </button>
              </span>
            </label>
          </>
        )}

        {status === "error" && (
          <p className="mt-2 text-[12px] font-bold text-brandred">{error}</p>
        )}

        <button
          type="submit"
          disabled={status === "loading"}
          className="btn btn-primary mt-4 w-full rounded-2xl py-3 text-sm disabled:opacity-60"
        >
          {status === "loading"
            ? "One moment..."
            : needsSignup
            ? "Create my account"
            : "Continue"}
        </button>

        {!googleCredential && (
          <>
            <div className="my-3 flex items-center gap-3 text-[11px] font-bold text-faint">
              <span className="h-px flex-1 bg-line" /> OR <span className="h-px flex-1 bg-line" />
            </div>
            <div ref={googleDiv} className="flex justify-center" />
          </>
        )}

        <p className="mt-3 flex items-center justify-center gap-1.5 text-[11px] text-faint">
          <Icon name="lock" className="h-3.5 w-3.5" />
          Secure signed session. Your details are stored safely.
        </p>
      </form>

      {showTerms && <TermsModal onClose={() => setShowTerms(false)} />}
    </main>
  );
}
