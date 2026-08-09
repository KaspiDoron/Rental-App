// The one place a message leaves for an agency on the official number.
//
// TWO LANES, AND THEY BEHAVE NOTHING LIKE EACH OTHER. Everything in Part 12.2
// follows from this, so it is restated here where the code lives:
//
//   TEMPLATE lane (no inbound from this agency in 24h): pre-approved content
//   only, metered against the portfolio tier, priced per message, and subject
//   to the per-recipient marketing cap that produces error 131049.
//
//   SERVICE-WINDOW lane (agency messaged us within 24h): free-form, free, and
//   it does NOT count against the tier at all, because the tier meters unique
//   recipients contacted OUTSIDE a window.
//
// So the design goal of every caller is to be in the second lane. The first
// traveller to pick an agency pays the template; if that agency answers, every
// other traveller that day is free, uncapped and instant.

import "server-only";
import { digitsOnly } from "../phone";
import { wabaConfig, wabaBlockReason, type WabaConfig } from "./config";

export type WabaLane = "template" | "freeform";

export interface WabaSendResult {
  ok: boolean;
  lane: WabaLane;
  messageId?: string;
  /** Rendered wire text - always present, including in dry run. */
  preview: string;
  /** True when nothing left the process. */
  dryRun: boolean;
  error?: string;
  /** Meta error code when the provider surfaced one - 131049 etc. */
  errorCode?: number;
  /**
   * The recipient has hit their per-user marketing cap (131049). NOT a failure
   * to retry: retrying burns quality rating for a message that is guaranteed
   * undeliverable until the cap resets.
   */
  recipientCapped?: boolean;
}

export interface TemplateSend {
  lane: "template";
  to: string;
  templateName: string;
  language: string;
  /** Body variables, in order. */
  variables: string[];
  /** Suffix appended to the approved button base URL. */
  buttonSuffix: string;
}

export interface FreeformSend {
  lane: "freeform";
  to: string;
  text: string;
}

export type WabaMessage = TemplateSend | FreeformSend;

/** Human-readable rendering of what will go out. The console shows this. */
export function previewOf(m: WabaMessage, c: WabaConfig): string {
  if (m.lane === "freeform") return m.text;
  const vars = m.variables.map((v, i) => `{{${i + 1}}}=${v}`).join(" ");
  return `[template ${m.templateName}/${m.language}] ${vars} -> ${c.linkBase}/${m.buttonSuffix}`;
}

function metaBody(m: WabaMessage, c: WabaConfig): Record<string, unknown> {
  const to = digitsOnly(m.to);
  if (m.lane === "freeform") {
    return { messaging_product: "whatsapp", to, type: "text", text: { body: m.text } };
  }
  return {
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: {
      name: m.templateName,
      language: { code: m.language },
      components: [
        {
          type: "body",
          parameters: m.variables.map((text) => ({ type: "text", text })),
        },
        {
          // Dynamic URL button: a fixed approved base plus a variable suffix.
          //
          // The suffix is a token on OUR domain, not a wa.me link - `wa.me`
          // URLs and link shorteners are named template-rejection causes, so a
          // template carrying one would never have been approved in the first
          // place. Routing through our own domain is what makes the one-tap
          // handoff possible at all, and it is also where the per-agency tap
          // telemetry comes from.
          type: "button",
          sub_type: "url",
          index: "0",
          parameters: [{ type: "text", text: m.buttonSuffix }],
        },
      ],
    },
  };
}

/**
 * Send on the official number.
 *
 * Never throws. A messaging integration that can throw into a drain loop takes
 * the loop down with it, and this one runs against an asset shared by every
 * user at once.
 */
export async function wabaSend(m: WabaMessage): Promise<WabaSendResult> {
  const c = await wabaConfig();
  const preview = previewOf(m, c);
  const blocked = wabaBlockReason(c);
  if (blocked) {
    return { ok: false, lane: m.lane, preview, dryRun: true, error: blocked };
  }

  // DRY RUN: render everything, send nothing. This is how the template, the
  // variables and the button target are verified without spending quality
  // rating on a rented account.
  if (c.dryRun) {
    return { ok: true, lane: m.lane, preview, dryRun: true, messageId: "dry-run" };
  }

  // Same hard timeout discipline as the existing Cloud API sender: a stalled
  // provider must not hold a request open to the platform ceiling.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12_000);
  (timer as { unref?: () => void }).unref?.();
  try {
    // Every reseller proxies the Cloud API underneath, so one dialect covers
    // both. `provider` selects the auth header shape, which is the only part
    // that genuinely differs: Meta takes a bearer token, most resellers take an
    // API key header.
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (c.provider === "meta") headers.Authorization = `Bearer ${c.apiKey}`;
    else headers.Authorization = `App ${c.apiKey}`;

    const res = await fetch(`${c.baseUrl}/${c.senderId}/messages`, {
      method: "POST",
      signal: ctrl.signal,
      headers,
      body: JSON.stringify(metaBody(m, c)),
    });
    const data = (await res.json().catch(() => ({}))) as {
      messages?: { id?: string }[];
      error?: { message?: string; code?: number };
    };
    if (!res.ok) {
      const code = data?.error?.code;
      return {
        ok: false,
        lane: m.lane,
        preview,
        dryRun: false,
        error: data?.error?.message ?? `provider ${res.status}`,
        errorCode: code,
        // 131049 - "not delivered to maintain healthy ecosystem engagement".
        // The recipient has hit their per-user marketing cap across ALL
        // businesses, so this is a property of their inbox, not of our request.
        recipientCapped: code === 131049,
      };
    }
    return {
      ok: true,
      lane: m.lane,
      preview,
      dryRun: false,
      messageId: data?.messages?.[0]?.id,
    };
  } catch (e) {
    return {
      ok: false,
      lane: m.lane,
      preview,
      dryRun: false,
      error: e instanceof Error ? e.message : "network error",
    };
  } finally {
    clearTimeout(timer);
  }
}
