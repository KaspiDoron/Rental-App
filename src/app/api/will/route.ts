import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { chat, extractJson } from "@/lib/ai";
import {
  parseWillCommandDeterministic,
  findVendor,
  type WillCommand,
  type WillContext,
  clampRadius,
} from "@/lib/will-commands";
import { composeStatus, composeWhy, composeCompare } from "@/lib/will-answers";

// Will's brain: natural language in -> ONE typed command + a short spoken
// confirmation out. The deterministic parser handles the unambiguous cases
// instantly (and is the keyless fallback); the LLM covers everything else.
// Will can only ever return commands the UI itself can execute - no new
// powers, just a conversational steering wheel.

interface WillRequest {
  text: string;
  context: WillContext;
  history?: { role: "user" | "assistant"; content: string }[];
}

const SYSTEM = `You are Will, WheelDeal's rental-negotiation specialist - calm, efficient, transparent, travel-savvy. A traveller steers their live rental search by talking to you.

Respond with ONE JSON object, nothing else:
{"action": "...", ...fields, "say": "<your short reply to the traveller, 1-2 sentences, warm and concrete>"}

Allowed actions (never invent others):
- {"action":"set_radius","km":<2-25>}
- {"action":"set_filter","patch":{...},"label":"<short label>"} - patch may set: vehicleClass ("scooter"|"motorbike"|"car"|"any"), deliveryOnly (bool), minRating (1-5), openNowOnly (bool), sort ("distance"|"rating"|"savings"|"status")
- {"action":"set_budget","maxPricePerDay":<number|null>}
- {"action":"start_search","text":"<what to search>"} - only when they clearly ask for a NEW search
- {"action":"clear_search"} - destructive; only on an explicit ask (the UI still confirms)
- {"action":"pause_session"} / {"action":"resume_session"}
- {"action":"mass_bargain"} - ask every shop at once / negotiate harder
- {"action":"compare","vendorIds":["id1","id2"]} - use ids from the context, cheapest first, 2-3 max
- {"action":"open_vendor","vendorId":"<id>"} - jump to one shop's card
- {"action":"remember","note":"<standing instruction>"} - preferences to honour this session
- {"action":"answer","text":"__STATUS__"} - they ask what's happening / progress
- {"action":"answer","text":"__WHY__"} - they ask why an option/move was chosen
- {"action":"answer","text":"<direct answer>"} - other questions you can answer from the context alone
- {"action":"clarify","text":"<one short question>"} - when you genuinely can't tell what they want

Rules: never fabricate shops, prices or ids not present in the context. Prefer acting over clarifying. "say" always confirms concretely what you did or found.`;

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  const body = (await req.json().catch(() => null)) as WillRequest | null;
  const text = (body?.text ?? "").toString().slice(0, 600).trim();
  const ctx = body?.context;
  if (!text || !ctx) {
    return NextResponse.json({ error: "text and context required" }, { status: 400 });
  }

  // 1) Fast path: deterministic parse (also the keyless fallback).
  let command: WillCommand | null = parseWillCommandDeterministic(text, ctx);
  let say: string | null = null;

  // 2) Otherwise the LLM maps intent -> command.
  if (!command) {
    const history = (body?.history ?? [])
      .slice(-8)
      .map((m) => ({ role: m.role, content: String(m.content).slice(0, 500) }));
    const ctxLine = JSON.stringify({
      phase: ctx.phase,
      radiusKm: ctx.radiusKm,
      paused: ctx.paused,
      plan: ctx.plan,
      origin: ctx.originLabel,
      offersIn: ctx.offersIn,
      notes: ctx.notes.slice(0, 5),
      vendors: ctx.vendors.slice(0, 12).map((v) => ({
        id: v.id,
        name: v.name,
        pricePerDay: v.pricePerDay,
        currency: v.currency,
        stage: v.stage,
      })),
    });
    const out = await chat(
      [
        { role: "system", content: SYSTEM },
        ...history,
        { role: "user", content: `CONTEXT: ${ctxLine}\n\nTRAVELLER: ${text}` },
      ],
      { maxTokens: 400, budgetMs: 12_000 }
    ).catch(() => null);
    if (out) {
      const parsed = extractJson<WillCommand & { say?: string }>(out);
      if (parsed && typeof parsed.action === "string") {
        const { say: parsedSay, ...cmd } = parsed;
        command = sanitize(cmd as WillCommand, ctx);
        say = typeof parsedSay === "string" ? parsedSay.slice(0, 400) : null;
      }
    }
  }

  if (!command) {
    command = {
      action: "clarify",
      text: "I didn't quite catch that - do you want me to change the search (radius, budget, vehicle), compare offers, or tell you what's happening?",
    };
  }

  // 3) Server-composed answers for status / why / compare.
  if (command.action === "answer" && command.text === "__STATUS__") {
    const answer = await composeStatus(session.email, ctx);
    return NextResponse.json({ command: { action: "answer", text: answer }, say: answer });
  }
  if (command.action === "answer" && command.text === "__WHY__") {
    const answer = await composeWhy(session.email, ctx);
    return NextResponse.json({ command: { action: "answer", text: answer }, say: answer });
  }
  if (command.action === "compare") {
    const n = command.vendorIds.length || 3;
    const { text: cmpText, vendorIds } = composeCompare(ctx, n);
    if (vendorIds.length >= 2) {
      return NextResponse.json({
        command: { action: "compare", vendorIds },
        say: say ?? cmpText,
      });
    }
    return NextResponse.json({ command: { action: "answer", text: cmpText }, say: cmpText });
  }

  return NextResponse.json({ command, say: say ?? defaultSay(command, ctx) });
}

/** Clamp/validate whatever the LLM produced - it can never exceed the UI. */
function sanitize(cmd: WillCommand, ctx: WillContext): WillCommand | null {
  switch (cmd.action) {
    case "set_radius":
      return Number.isFinite(cmd.km) ? { action: "set_radius", km: clampRadius(cmd.km) } : null;
    case "set_budget": {
      const v = cmd.maxPricePerDay;
      if (v === null) return cmd;
      return Number.isFinite(v) && v! > 0 ? { action: "set_budget", maxPricePerDay: Math.round(v!) } : null;
    }
    case "set_filter": {
      if (!cmd.patch || typeof cmd.patch !== "object") return null;
      const allowed = ["vehicleClass", "deliveryOnly", "minRating", "openNowOnly", "sort", "maxPricePerDay"];
      const patch: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(cmd.patch)) if (allowed.includes(k)) patch[k] = v;
      return Object.keys(patch).length > 0
        ? { action: "set_filter", patch: patch as typeof cmd.patch, label: cmd.label }
        : null;
    }
    case "open_vendor": {
      const v = ctx.vendors.find((x) => x.id === cmd.vendorId) ?? findVendor(ctx, cmd.vendorId);
      return v ? { action: "open_vendor", vendorId: v.id } : null;
    }
    case "compare": {
      const ids = (cmd.vendorIds ?? []).filter((id) => ctx.vendors.some((v) => v.id === id));
      return { action: "compare", vendorIds: ids };
    }
    case "start_search":
      return { action: "start_search", text: typeof cmd.text === "string" ? cmd.text.slice(0, 300) : undefined };
    case "remember":
      return typeof cmd.note === "string" && cmd.note.trim()
        ? { action: "remember", note: cmd.note.trim().slice(0, 200) }
        : null;
    case "answer":
    case "clarify":
      return typeof cmd.text === "string" && cmd.text.trim() ? cmd : null;
    case "clear_search":
    case "pause_session":
    case "resume_session":
    case "mass_bargain":
      return cmd;
    default:
      return null;
  }
}

function defaultSay(cmd: WillCommand, ctx: WillContext): string {
  switch (cmd.action) {
    case "set_radius":
      return `Done - radius is now ${cmd.km} km. New shops in that ring join the next sweep.`;
    case "set_budget":
      return cmd.maxPricePerDay
        ? `Got it - I'll only surface options at ${cmd.maxPricePerDay}/day or less.`
        : "Budget cap removed - showing everything again.";
    case "set_filter":
      return `Done - ${cmd.label ?? "filter updated"}.`;
    case "start_search":
      return "On it - structuring your request and finding every shop around you.";
    case "clear_search":
      return "Sure - confirm in the dialog and I'll wipe this search.";
    case "pause_session":
      return "Paused. I'll store every reply but send nothing until you say resume.";
    case "resume_session":
      return "Back on it - resuming the negotiations where we left off.";
    case "mass_bargain":
      return ctx.waConnected
        ? "Going wide - asking every remaining shop at once, each with its own wording."
        : "I'd love to - connect your WhatsApp in Profile first and I'll blast it.";
    case "open_vendor":
      return "Taking you to that shop's card.";
    case "remember":
      return `Noted - I'll keep that in mind for this session: "${cmd.note}".`;
    default:
      return "Done.";
  }
}

export const maxDuration = 60;
