import { NextResponse } from "next/server";
import { requireManagement } from "@/lib/session";
import { getConfig, setConfig } from "@/lib/runtime-config";
import {
  paypalConfigured,
  listPaypalWebhooks,
  createPaypalWebhook,
  patchPaypalWebhook,
  PAYPAL_WEBHOOK_EVENTS,
} from "@/lib/paypal";
import { resolveSiteOrigin } from "@/lib/site";

// PAYPAL WEBHOOK DOCTOR (wave 4.3, wa-doctor template).
//
// No webhook was ever registered on the PayPal app, so the ONLY code path
// that can LOWER a plan (cancellation/expiry) never ran - cancelled
// subscribers kept paid tiers forever - while the admin key-test reported
// green off an empty webhook list. The doctor makes the state VISIBLE (GET)
// and the repair ONE BUTTON (POST): list -> PATCH-or-create -> store the id
// in the vault -> re-list to verify. It never deletes anything, and the
// webhook URL comes from resolveSiteOrigin() - never from request headers,
// which an attacker controls.

const WEBHOOK_PATH = "/api/webhooks/paypal";

type DoctorState = "unconfigured" | "unreadable" | "absent" | "mismatch" | "verified";

async function diagnose(): Promise<{
  state: DoctorState;
  expectedUrl: string | null;
  storedId: string | null;
  hooks: { id: string; url: string; eventTypes: string[] }[] | null;
  detail: string;
}> {
  const storedId = ((await getConfig("PAYPAL_WEBHOOK_ID")) ?? "").trim() || null;
  if (!(await paypalConfigured())) {
    return {
      state: "unconfigured",
      expectedUrl: null,
      storedId,
      hooks: null,
      detail: "Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET first (Admin -> Keys).",
    };
  }
  const origin = await resolveSiteOrigin();
  const expectedUrl = `${origin}${WEBHOOK_PATH}`;
  const hooks = await listPaypalWebhooks();
  if (hooks === null) {
    return {
      state: "unreadable",
      expectedUrl,
      storedId,
      hooks: null,
      detail:
        "PayPal's webhook list could not be read - credentials rejected or network. " +
        "This is unknown, not healthy.",
    };
  }
  const ours = hooks.find((h) => h.url === expectedUrl);
  if (!ours) {
    return {
      state: "absent",
      expectedUrl,
      storedId,
      hooks,
      detail:
        `No webhook points at ${expectedUrl}. Cancellations and renewals are NOT reaching ` +
        "the app - press Connect webhook.",
    };
  }
  const missingEvents = PAYPAL_WEBHOOK_EVENTS.filter((e) => !ours.eventTypes.includes(e));
  if (storedId !== ours.id || missingEvents.length > 0) {
    return {
      state: "mismatch",
      expectedUrl,
      storedId,
      hooks,
      detail:
        (storedId !== ours.id
          ? `PAYPAL_WEBHOOK_ID (${storedId ?? "unset"}) is not the webhook at our URL (${ours.id}). `
          : "") +
        (missingEvents.length
          ? `Webhook is missing events: ${missingEvents.join(", ")}. `
          : "") +
        "Press Connect webhook to repair.",
    };
  }
  return {
    state: "verified",
    expectedUrl,
    storedId,
    hooks,
    detail: `Webhook ${ours.id} points at ${expectedUrl} with all ${PAYPAL_WEBHOOK_EVENTS.length} events, and PAYPAL_WEBHOOK_ID matches.`,
  };
}

export async function GET() {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const d = await diagnose();
  return NextResponse.json(d);
}

export async function POST(req: Request) {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const body = (await req.json().catch(() => ({}))) as { action?: string };
  const action = String(body?.action ?? "connect");

  if (action === "reconcile") {
    const { reconcilePaypalPlans } = await import("@/lib/billing/reconcile");
    const result = await reconcilePaypalPlans();
    return NextResponse.json(result);
  }

  if (action !== "connect") {
    return NextResponse.json({ error: `Unknown action "${action}".` }, { status: 400 });
  }

  if (!(await paypalConfigured())) {
    return NextResponse.json(
      { error: "Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET first." },
      { status: 400 }
    );
  }
  const origin = await resolveSiteOrigin();
  const expectedUrl = `${origin}${WEBHOOK_PATH}`;
  // PayPal itself refuses http; refusing HERE gives the owner a message that
  // names the actual problem (APP_DOMAIN not set to the public https origin).
  if (!expectedUrl.startsWith("https://")) {
    return NextResponse.json(
      {
        error:
          `The site origin resolves to ${origin} - PayPal webhooks require https. ` +
          "Set APP_DOMAIN (Admin -> Keys) to the public https domain first.",
      },
      { status: 400 }
    );
  }
  const hooks = await listPaypalWebhooks();
  if (hooks === null) {
    return NextResponse.json(
      { error: "Could not read the PayPal webhook list - fix credentials first." },
      { status: 502 }
    );
  }

  const ours = hooks.find((h) => h.url === expectedUrl);
  let webhookId = ours?.id ?? null;
  if (ours) {
    // Repair in place (events may be stale). NEVER delete - some other system
    // may depend on a webhook we did not create.
    const patched = await patchPaypalWebhook(ours.id, expectedUrl);
    if (!patched) {
      return NextResponse.json(
        { error: `PayPal refused to update webhook ${ours.id}.` },
        { status: 502 }
      );
    }
  } else {
    const created = await createPaypalWebhook(expectedUrl);
    if (!created.id) {
      return NextResponse.json(
        { error: created.error ?? "PayPal refused to create the webhook." },
        { status: 502 }
      );
    }
    webhookId = created.id;
  }

  const stored = await setConfig("PAYPAL_WEBHOOK_ID", webhookId!);
  if (!stored.ok) {
    return NextResponse.json(
      {
        error:
          `Webhook ${webhookId} exists at PayPal but PAYPAL_WEBHOOK_ID could not be stored ` +
          "in the vault - signature verification will still fail. Paste it in Admin -> Keys.",
        webhookId,
      },
      { status: 502 }
    );
  }

  // VERIFY rather than trust the write path - the wa-doctor rule.
  const after = await diagnose();
  return NextResponse.json({ ok: after.state === "verified", ...after });
}

export const maxDuration = 60;
