import { NextResponse } from "next/server";
import { requireManagement } from "@/lib/session";
import { sbSelectStrict } from "@/lib/runtime-config";
import { wabaConfig, wabaBlockReason, WABA_BLOCK_LABELS } from "@/lib/waba/config";
import { governorVerdict } from "@/lib/waba/governor";

export const dynamic = "force-dynamic";

/**
 * The Business Platform console's data. Admin only, bounded reads, no polling.
 *
 * FAIL DARK. `null` means unreadable and the panel renders a dash; it never
 * renders as zero. This repo has twice shipped a surface that reported "all
 * good" because its reads failed to `[]`, and on this screen a false green
 * means "the official number is fine" while it is being restricted.
 */
type Maybe<T> = T | null;

interface LeadRow {
  id: number;
  state: string;
  lane: string | null;
  agency_name: string | null;
  agency_tail: string;
  user_email: string;
  created_at: string;
  sent_at: string | null;
  delivered_at: string | null;
  read_at: string | null;
  link_tapped_at: string | null;
  traveller_inbound_at: string | null;
  handed_off_at: string | null;
  terminal_reason: string | null;
  error_code: number | null;
  preview: string | null;
}

export async function GET() {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const c = await wabaConfig();
  const blocked = wabaBlockReason(c);
  const degraded: string[] = [];

  const read = await sbSelectStrict<LeadRow>(
    "waba_leads",
    "select=*&order=created_at.desc&limit=200"
  );
  let leads: Maybe<LeadRow[]> = null;
  if ("error" in read) {
    if (read.error === "unavailable") degraded.push("lead ledger");
    else leads = [];
  } else {
    leads = read.rows;
  }

  const agRead = await sbSelectStrict<{
    agency_tail: string;
    agency_name: string | null;
    window_expires_at: string | null;
    template_capped_until: string | null;
    last_template_at: string | null;
    sent_total: number;
    tapped_total: number;
    replied_total: number;
  }>("waba_agencies", "select=*&order=updated_at.desc&limit=200");
  let agencies: Maybe<typeof agRead extends { rows: infer R } ? R : never> = null;
  if ("error" in agRead) {
    if (agRead.error === "unavailable") degraded.push("agency state");
    else agencies = [] as never;
  } else {
    agencies = agRead.rows as never;
  }

  // THE FUNNEL. `tapped` is the column that says whether the message WORKED -
  // delivered and read only say it arrived. No other surface in this product
  // has that signal.
  const funnel = leads
    ? {
        sent: leads.filter((l) => l.sent_at).length,
        delivered: leads.filter((l) => l.delivered_at).length,
        read: leads.filter((l) => l.read_at).length,
        tapped: leads.filter((l) => l.link_tapped_at).length,
        travellerContacted: leads.filter((l) => l.traveller_inbound_at).length,
        handedOff: leads.filter((l) => l.handed_off_at).length,
        held: leads.filter((l) => l.state === "held").length,
        failed: leads.filter((l) => l.state === "failed").length,
      }
    : null;

  const gov = await governorVerdict();

  return NextResponse.json({
    generatedAt: Date.now(),
    connection: {
      enabled: c.enabled,
      dryRun: c.dryRun,
      provider: c.provider,
      // Credentials are reported as PRESENT or ABSENT, never echoed. An admin
      // surface has no reason to hand back a key it was given.
      hasKey: Boolean(c.apiKey),
      senderConfigured: Boolean(c.senderId),
      template: c.templateFirstContact || null,
      reengageTemplate: c.templateReengage || null,
      linkBase: c.linkBase || null,
      blocked,
      blockedLabel: blocked ? WABA_BLOCK_LABELS[blocked] : null,
    },
    // ENGINE TRUTH: every code path that can put a message on WhatsApp, and
    // whether it can do so RIGHT NOW. The owner's rule is one sentence - only
    // Evolution sends until real WABA credentials arrive - and until this
    // existed there was no single place that could confirm it. The second
    // official sender (lib/whatsapp.ts) in particular was off only because two
    // Key Vault fields happened to be blank, which is not something a person
    // can see from any screen.
    senders: [
      {
        id: "evolution",
        label: "Evolution (per-user WhatsApp session)",
        live: true,
        detail: "The only live sender. Every traveller message goes out from their own linked number.",
      },
      {
        id: "waba-handoff",
        label: "Business-number handoff (Part 12)",
        live: c.enabled && !c.dryRun && blocked === null,
        detail: !c.enabled
          ? "Off - WABA_ENABLED is not on."
          : blocked
            ? WABA_BLOCK_LABELS[blocked]
            : c.dryRun
              ? "Flag on, but WABA_DRY_RUN is on - composes and records, sends nothing."
              : "LIVE - the official number makes first contact.",
      },
      {
        id: "cloud-api",
        label: "Meta Cloud API direct sender (legacy)",
        live: await (await import("@/lib/whatsapp")).whatsappConfigured(),
        detail: !c.enabled
          ? (await (await import("@/lib/whatsapp")).whatsappCredentialsPresent())
            ? "Off - credentials ARE set, but WABA_ENABLED is not on. This is the intended state."
            : "Off - WABA_ENABLED is not on, and no credentials are set."
          : "LIVE - WABA_ENABLED is on and Cloud API credentials are set.",
      },
    ],
    governor: gov,
    funnel,
    leads,
    agencies,
    degraded,
  });
}
