"use client";

import { useEffect, useRef, useState } from "react";
import { BrandMark } from "@/components/BrandMark";
import { TermsModal } from "@/components/TermsModal";
import { PlanCard, type PlanView } from "@/components/UpgradeSheet";
import { CountryPhoneInput } from "@/components/CountryPhoneInput";
import { WaConnect } from "@/components/WaConnect";
import { PasswordInput } from "@/components/PasswordInput";
import { LanguageButton } from "@/components/LanguageButton";
import { LoadingDots } from "@/components/LoadingDots";
import { Icon } from "@/components/icons";
import { useI18n } from "@/lib/i18n";

declare global {
  interface Window {
    google?: any;
  }
}

type Mode = "login" | "signup";

export default function LoginPage() {
  const { t } = useI18n();
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [phone, setPhone] = useState("");
  const [acceptTerms, setAcceptTerms] = useState(false);
  const [googleCredential, setGoogleCredential] = useState<string | null>(null);
  const [googleName, setGoogleName] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [forgotBusy, setForgotBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [showTerms, setShowTerms] = useState(false);
  const [step, setStep] = useState<"auth" | "whatsapp" | "plans">("auth");
  const [plans, setPlans] = useState<PlanView[]>([]);
  const [subBusy, setSubBusy] = useState(false);
  const googleDiv = useRef<HTMLDivElement>(null);

  // Google OAuth button (renders when a client id is configured).
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
        /* button simply doesn't render */
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function enterApp(session: any, opts?: { welcome?: boolean; changePw?: boolean }) {
    if (opts?.changePw) {
      window.location.href = "/profile?pw=1";
      return;
    }
    const base = session?.role && session.role !== "user" ? "/admin" : "/";
    window.location.href = opts?.welcome ? `${base}?welcome=1` : base;
  }

  async function afterAuth(data: any, isNew: boolean) {
    if (data.mustChangePassword) {
      enterApp(data.session, { changePw: true });
      return;
    }
    if (isNew && data.session?.role === "user") {
      // WhatsApp is part of signing up: without it the agents cannot bargain.
      try {
        const wa = await (await fetch("/api/wa/status")).json();
        if (wa.available && !wa.connected) {
          setStep("whatsapp");
          return;
        }
      } catch {}
      await goPlans();
      return;
    }
    enterApp(data.session, { welcome: isNew });
  }

  async function goPlans() {
    {
      try {
        const res = await fetch("/api/billing/checkout");
        const d = await res.json();
        const paid = (d.plans ?? []).filter((p: PlanView) => p.amount > 0);
        if (paid.length) {
          setPlans(paid);
          setStep("plans");
          return;
        }
      } catch {}
    }
    window.location.href = "/?welcome=1";
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    // Google-verified signups finish through the Google endpoint - they have
    // no password (Google IS the credential). This was the loop bug.
    if (googleCredential) {
      await submitGoogle(googleCredential, true);
      return;
    }
    setStatus("loading");
    setError("");
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, email, password, phone, acceptTerms }),
      });
      const data = await res.json();
      if (!res.ok) {
        setStatus("error");
        setError(data.error ?? t("Something went wrong."));
        if (data.needsSignup) setMode("signup");
        return;
      }
      await afterAuth(data, mode === "signup");
    } catch {
      setStatus("error");
      setError(t("Network error - please try again."));
    }
  }

  async function submitGoogle(credential: string, withProfile = false) {
    setStatus("loading");
    setError("");
    try {
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
        setMode("signup");
        setStatus("idle");
        setNotice(
          t("Almost there - add your phone and accept the terms. No password needed: you'll always sign in with Google.")
        );
        return;
      }
      if (!res.ok) {
        setStatus("error");
        setError(data.error ?? t("Google sign-in failed."));
        return;
      }
      await afterAuth(data, Boolean(data.isNew));
    } catch {
      setStatus("error");
      setError(t("Network error - please try again."));
    }
  }

  async function forgot() {
    if (!email) {
      setError(t("Type your email above first, then tap Forgot password."));
      setStatus("error");
      return;
    }
    setForgotBusy(true);
    setError("");
    setNotice("");
    try {
      const res = await fetch("/api/auth/forgot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await res.json();
      if (!res.ok) {
        setStatus("error");
        setError(data.error ?? t("Could not send the email."));
      } else {
        setStatus("idle");
        setNotice(data.message);
      }
    } catch {
      setStatus("error");
      setError(t("Network error - please try again."));
    } finally {
      setForgotBusy(false);
    }
  }

  async function devLogin(persona: string) {
    setStatus("loading");
    const res = await fetch("/api/auth/dev", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ persona }),
    });
    const data = await res.json();
    if (res.ok) enterApp(data.session);
    else setStatus("idle");
  }

  if (step === "whatsapp") {
    return (
      <main className="mx-auto flex min-h-[100dvh] max-w-md flex-col justify-center px-5 pb-safe pt-safe">
        <div className="mb-4 text-center">
          <div className="mx-auto mb-2 w-fit animate-slide-up">
            <BrandMark size={72} />
          </div>
          <h1 className="font-display text-2xl font-extrabold text-strong">
            {t("Last step: connect WhatsApp")} 💬
          </h1>
          <p className="mx-auto mt-1 max-w-[300px] text-sm text-soft">
            {t("This is how the agents bargain for you - shops answer YOUR number and every reply lands in the app.")}
          </p>
        </div>
        <div className="surface rounded-blob p-5">
          <WaConnect phone={phone} onConnected={() => goPlans()} />
        </div>
        <button
          onClick={() => goPlans()}
          className="btn mx-auto mt-3 text-[11px] font-bold text-faint underline"
        >
          {t("Having trouble? Connect later from Profile")}
        </button>
      </main>
    );
  }

  if (step === "plans") {
    return (
      <main className="mx-auto flex min-h-[100dvh] max-w-md flex-col justify-center px-5 pb-safe pt-safe">
        <div className="mb-4 text-center">
          <h1 className="font-display text-2xl font-extrabold text-strong">
            {t("Welcome aboard!")} 🎉
          </h1>
          <p className="mt-1 text-sm font-bold text-brandred">
            {t("One-time opening offer: 80% off, billed every 3 months")}
          </p>
        </div>
        <div className="space-y-3">
          {plans.map((p) => (
            <PlanCard
              key={p.id}
              plan={p}
              busy={subBusy}
              onSubscribe={async (id) => {
                setSubBusy(true);
                try {
                  const res = await fetch("/api/billing/checkout", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ planId: id }),
                  });
                  const d = await res.json();
                  if (d.url) window.location.href = d.url;
                  else window.location.href = "/?welcome=1";
                } finally {
                  setSubBusy(false);
                }
              }}
            />
          ))}
        </div>
        <button
          onClick={() => (window.location.href = "/?welcome=1")}
          className="btn btn-ghost mx-auto mt-4 rounded-2xl px-6 py-2.5 text-sm"
        >
          {t("Maybe later - start saving")}
        </button>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-[100dvh] max-w-md flex-col justify-center px-5 pb-safe pt-safe">
      {/* Global translate - flashy so every traveller notices it up front */}
      <div
        className="fixed right-4 z-40"
        style={{ top: "calc(env(safe-area-inset-top, 0px) + 12px)" }}
      >
        <LanguageButton flashy />
      </div>

      {/* Hero */}
      <div className="mb-5 text-center">
        <div className="mx-auto mb-2 w-fit animate-slide-up">
          <BrandMark size={92} />
        </div>
        <h1 className="font-display text-3xl font-extrabold text-strong">
          Wheel<span className="text-brandblue">Deal</span>
        </h1>
        <p className="mx-auto mt-1 max-w-[280px] text-sm text-soft">
          {t("AI agents hunt the cheapest scooter, motorcycle and car rentals around your hotel - and bargain for you.")}
        </p>
        <div className="mx-auto mt-2 flex w-fit flex-wrap items-center justify-center gap-1.5">
          <span className="badge-flash rounded-full px-3 py-1 text-[11px] font-extrabold">
            🤝 {t("Authentic bargaining")}
          </span>
          <span className="rounded-full bg-brandblue-soft px-3 py-1 text-[11px] font-extrabold text-brandblue">
            🔐 {t("Sign in or create an account to enter")}
          </span>
        </div>
      </div>

      {/* Mode switch */}
      <div className="surface-strong mb-3 flex gap-1 rounded-2xl p-1">
        {(["login", "signup"] as Mode[]).map((m) => (
          <button
            key={m}
            onClick={() => {
              setMode(m);
              setError("");
              setNotice("");
            }}
            className={`btn btn-sm flex-1 rounded-xl py-2.5 text-[13px] font-extrabold ${
              mode === m ? "bg-brandblue text-white" : "text-soft hover:bg-card2"
            }`}
          >
            {m === "login" ? t("Log in") : t("Sign up")}
          </button>
        ))}
      </div>

      <form onSubmit={submit} className="surface rounded-blob p-5">
        {googleCredential ? (
          <div className="mb-3 flex items-center gap-2 rounded-2xl bg-brandblue-soft p-3 text-[13px] font-bold text-brandblue">
            <Icon name="check" className="h-4 w-4" />
            {t("Google verified")}
            {googleName ? `: ${googleName}` : ""} ({email})
          </div>
        ) : (
          <>
            <label className="text-[12px] font-extrabold text-soft">{t("Email")}</label>
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

        {!googleCredential && (
          <>
            <label className="mt-3 block text-[12px] font-extrabold text-soft">
              {t("Password")}
            </label>
            <div className="mt-1">
              <PasswordInput
                value={password}
                onChange={setPassword}
                required
                minLength={mode === "signup" ? 6 : 1}
                autoComplete={mode === "signup" ? "new-password" : "current-password"}
                placeholder={
                  mode === "signup"
                    ? t("Choose a password (6+ characters)")
                    : t("Your password")
                }
              />
            </div>
            {mode === "login" && (
              <button
                type="button"
                onClick={forgot}
                disabled={forgotBusy}
                className="btn mt-1 text-[12px] font-extrabold text-brandblue disabled:opacity-60"
              >
                {forgotBusy ? (
                  <LoadingDots label={t("Sending a reset email")} />
                ) : (
                  t("Forgot password?")
                )}
              </button>
            )}
          </>
        )}

        {mode === "signup" && (
          <>
            <label className="mt-3 block text-[12px] font-extrabold text-soft">
              {t("Phone number")}
            </label>
            <div className="mt-1">
              <CountryPhoneInput value={phone} onChange={setPhone} />
            </div>
            <label className="mt-3 flex items-start gap-2.5 text-[13px] text-soft">
              <input
                type="checkbox"
                checked={acceptTerms}
                onChange={(e) => setAcceptTerms(e.target.checked)}
                className="mt-0.5 h-5 w-5 accent-[var(--blue)]"
                required
              />
              <span>
                {t("I agree to the")}{" "}
                <button
                  type="button"
                  onClick={() => setShowTerms(true)}
                  className="font-extrabold text-brandblue underline"
                >
                  {t("Terms of Use")}
                </button>{" "}
                {t("and to the app using my phone's location to find rental shops near me.")}
              </span>
            </label>
          </>
        )}

        {notice && (
          <p className="mt-2 rounded-xl bg-savings-soft p-2 text-[12px] font-bold text-savings">
            {notice}
          </p>
        )}
        {status === "error" && (
          <p className="mt-2 text-[12px] font-bold text-brandred">{error}</p>
        )}

        <button
          type="submit"
          disabled={status === "loading"}
          className="btn btn-primary mt-4 w-full rounded-2xl py-3 text-sm disabled:opacity-60"
        >
          {status === "loading" ? (
            <LoadingDots light label={t("One moment")} />
          ) : googleCredential ? (
            t("Create my account")
          ) : mode === "login" ? (
            t("Log in")
          ) : (
            t("Create my account")
          )}
        </button>

        {!googleCredential && (
          <>
            <div className="my-3 flex items-center gap-3 text-[11px] font-bold text-faint">
              <span className="h-px flex-1 bg-line" /> {t("OR")}{" "}
              <span className="h-px flex-1 bg-line" />
            </div>
            <div ref={googleDiv} className="flex justify-center" />
          </>
        )}

        <p className="mt-3 flex items-center justify-center gap-1.5 text-[11px] text-faint">
          <Icon name="lock" className="h-3.5 w-3.5" />
          {t("Secure signed session. Your details are stored safely.")}
        </p>
      </form>

      {/* TEMPORARY dev entries - removed before public launch */}
      <div className="mt-4">
        <p className="mb-1.5 text-center text-[10px] font-extrabold uppercase tracking-wide text-faint">
          Dev quick entry (temporary)
        </p>
        <div className="flex flex-wrap justify-center gap-1.5">
          {[
            ["owner", "👑 Dev owner"],
            ["manager", "🛡 Dev manager"],
            ["free", "🙂 Dev user free"],
            ["pro", "⭐ Dev user pro"],
            ["ultra", "⚡ Dev user ultra"],
          ].map(([id, label]) => (
            <button
              key={id}
              onClick={() => devLogin(id)}
              className="btn btn-sm chip rounded-full border-2 border-dashed border-line bg-card px-3 py-1.5 text-[11px] font-bold text-faint hover:border-brandblue hover:text-brandblue"
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {showTerms && <TermsModal onClose={() => setShowTerms(false)} />}
    </main>
  );
}
