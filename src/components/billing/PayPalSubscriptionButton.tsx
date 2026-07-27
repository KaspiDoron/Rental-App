"use client";

// The subscribe button, once, for every tier that has one.
//
// Loaded through @paypal/react-paypal-js rather than a hand-written <script>
// tag: the provider owns the SDK's lifecycle, so the script is fetched once for
// the whole app, torn down cleanly, and never races a React remount. A manual
// tag in a component that can mount twice is how you end up with two SDKs and a
// button that renders into a node the first one already claimed.
//
// The client id and the plan ids come from the server at runtime (Admin ->
// Keys), so the owner can swap a billing plan without a redeploy. The SECRET is
// not here and cannot be: it lives only in the routes that talk to PayPal.
//
// What happens on approval is the important part. PayPal hands back a
// subscription id, and this component does NOT treat that as payment. It posts
// it to /api/subscriptions/paypal-success, which asks PayPal what the
// subscription actually is before anyone's plan changes. The button's job ends
// at "tell the server what just happened".

import { useEffect, useState } from "react";
import { PayPalScriptProvider, PayPalButtons } from "@paypal/react-paypal-js";
import { PAYPAL_PLANS, type PaidPlanId, type PaypalPublicConfig } from "@/lib/paypal-plans";
import type { PaypalSuccessResponse } from "@/app/api/subscriptions/paypal-success/route";

export interface PayPalSubscriptionButtonProps {
  plan: PaidPlanId;
  /** Called once the SERVER has verified and applied the new tier. */
  onActivated?: (plan: PaidPlanId) => void;
  /** Called with a human-readable reason when anything goes wrong. */
  onError?: (message: string) => void;
}

/** One provider for the whole page - the SDK must not be loaded per button. */
export function PayPalProvider({
  config,
  children,
}: {
  config: PaypalPublicConfig;
  children: React.ReactNode;
}) {
  if (!config.clientId) return <>{children}</>;
  return (
    <PayPalScriptProvider
      options={{
        clientId: config.clientId,
        vault: true,
        intent: "subscription",
        components: "buttons",
      }}
    >
      {children}
    </PayPalScriptProvider>
  );
}

/** Fetch the public PayPal config once. Null while loading or unconfigured. */
export function usePaypalConfig(): { config: PaypalPublicConfig | null; ready: boolean } {
  const [config, setConfig] = useState<PaypalPublicConfig | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let alive = true;
    fetch("/api/subscriptions/paypal-config", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: PaypalPublicConfig | null) => {
        if (alive) setConfig(d && d.clientId ? d : null);
      })
      .catch(() => {})
      .finally(() => {
        if (alive) setReady(true);
      });
    return () => {
      alive = false;
    };
  }, []);
  return { config, ready };
}

export function PayPalSubscriptionButton({
  plan,
  onActivated,
  onError,
}: PayPalSubscriptionButtonProps) {
  const spec = PAYPAL_PLANS[plan];
  const [busy, setBusy] = useState(false);
  const [planId, setPlanId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/subscriptions/paypal-config", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: PaypalPublicConfig | null) => {
        if (alive) setPlanId(d?.planIds?.[plan] ?? null);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [plan]);

  if (!planId) return null;

  return (
    <div className={busy ? "pointer-events-none opacity-60" : ""}>
      <PayPalButtons
        style={spec.style}
        // A fresh key per plan: PayPal renders into its own iframe and must not
        // be asked to swap plan ids inside one instance.
        forceReRender={[planId]}
        createSubscription={(_data, actions) =>
          actions.subscription.create({ plan_id: planId })
        }
        onApprove={async (data) => {
          const subscriptionID = String(data.subscriptionID ?? "");
          if (!subscriptionID) {
            onError?.("PayPal did not return a subscription - nothing was charged.");
            return;
          }
          setBusy(true);
          try {
            const res = await fetch("/api/subscriptions/paypal-success", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ subscriptionID, intendedPlan: plan }),
            });
            const d = (await res.json()) as PaypalSuccessResponse;
            if (res.ok && d.ok && d.plan) onActivated?.(d.plan);
            else {
              onError?.(
                d.error ??
                  "Your payment went through but we could not activate the plan - contact us and we will sort it out."
              );
            }
          } catch {
            onError?.(
              "Your payment went through but we could not reach our server - reopen the app in a moment and it will be there."
            );
          } finally {
            setBusy(false);
          }
        }}
        onError={() => onError?.("PayPal could not complete that - nothing was charged.")}
      />
    </div>
  );
}
