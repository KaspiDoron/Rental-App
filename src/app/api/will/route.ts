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
import { planCapacity } from "@/lib/wa/capacity";
import { pickVariant, pick } from "@/lib/will-variants";

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
- {"action":"open_deals"} - they want their deals/bookings/hunt history page
- {"action":"open_pricing"} - they ask about plans/pricing/upgrading (recommend honestly, never pushy)
- {"action":"open_feedback","topic":"<bug|idea|question|other>"} - they report a bug, complain about the APP, request a feature, or are frustrated with the product. Warmly guide them to the feedback box and open it.
- {"action":"help"} - they ask what you can do / how this works
- {"action":"answer","text":"<direct answer>"} - for product questions you can answer from context (features, how the search session works, why messages are paced, navigation). Explain in plain, friendly language.
- {"action":"clarify","text":"<one short question>"} - when you genuinely can't tell what they want

Recognise intent generously: confusion -> explain or guide; a complaint or bug about the APP -> open_feedback; a feature idea -> open_feedback; a question already answered somewhere in the app -> point them there in your "say". Never explain internal ban/anti-spam mechanics, WhatsApp limits, or unofficial APIs - speak only in outcomes ("your agent messages shops at a natural pace so replies keep flowing").

Voice: a warm, sharp, human concierge - never a scripted bot. VARY your wording every time; never open two replies the same way. 1-2 sentences, concrete.

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
      vehicleClass: ctx.vehicleClass,
      maxPricePerDay: ctx.maxPricePerDay,
      paused: ctx.paused,
      plan: ctx.plan,
      waConnected: ctx.waConnected,
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
    command = { action: "clarify", text: pickVariant("clarify") };
  }

  // 3) Server-composed answers for help / status / why / compare.
  if (command.action === "help") {
    const answer = helpSay(ctx);
    return NextResponse.json({ command: { action: "answer", text: answer }, say: answer });
  }
  if (command.action === "answer" && command.text === "__STATUS__") {
    const answer = await composeStatus(session.email, ctx);
    return NextResponse.json({ command: { action: "answer", text: answer }, say: answer });
  }
  if (command.action === "answer" && command.text === "__WHY__") {
    const answer = await composeWhy(session.email, ctx);
    return NextResponse.json({ command: { action: "answer", text: answer }, say: answer });
  }
  if (command.action === "answer" && command.text === "__SESSION__") {
    const answer = sessionExplainer();
    return NextResponse.json({ command: { action: "answer", text: answer }, say: answer });
  }
  if (command.action === "answer" && command.text === "__CAPACITY__") {
    const answer = capacityExplainer(ctx);
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
    case "open_feedback":
      return {
        action: "open_feedback",
        topic: typeof cmd.topic === "string" ? cmd.topic.slice(0, 24) : undefined,
      };
    case "clear_search":
    case "pause_session":
    case "resume_session":
    case "mass_bargain":
    case "open_deals":
    case "open_pricing":
    case "help":
      return cmd;
    default:
      return null;
  }
}

/** Plan-aware capability tour - Will explains what HE can do right now. */
function helpSay(ctx: WillContext): string {
  const base =
    "I run the whole hunt: say \"find me a 125cc scooter near my hotel\" and I search, message every shop and haggle. " +
    "You can steer me any time - \"radius 10km\", \"only automatic scooters\", \"under 200 a day\", \"pause everything\", " +
    "\"what's happening?\", \"why this shop?\", \"compare the top 3\", \"open my deals\". " +
    "I can also explain how anything here works, and if something's off or you have an idea, say \"give feedback\" and I'll open the box for you.";
  if (ctx.plan === "free") {
    return base + " On Free I work one shop at a time; Pro adds mass bargain (every shop in one tap) - say \"show plans\" if you're curious.";
  }
  if (ctx.plan === "pro") {
    return base + " You're on Pro, so \"negotiate harder\" fires a mass bargain at every open shop. Ultra adds local-language haggling - the strongest lever.";
  }
  return base + " You're on Ultra: I bargain in each shop's own language and you can ask \"why\" about any move I make.";
}

function defaultSay(cmd: WillCommand, ctx: WillContext): string {
  switch (cmd.action) {
    case "set_radius":
      return pick([
        `Radius is now ${cmd.km} km - new shops in that ring join the next sweep.`,
        `Widened your reach to ${cmd.km} km. I'll pull in whatever's there.`,
        `Set - ${cmd.km} km around your stay. Fresh shops get picked up automatically.`,
      ]);
    case "set_budget":
      return cmd.maxPricePerDay
        ? pick([
            `Got it - only options at ${cmd.maxPricePerDay}/day or less from here.`,
            `Capping it at ${cmd.maxPricePerDay}/day - I'll hide anything pricier.`,
            `Done. Nothing above ${cmd.maxPricePerDay}/day will clutter your list.`,
          ])
        : pick([
            "Budget cap lifted - showing every option again.",
            "Cleared the budget - the full range is back in view.",
          ]);
    case "set_filter":
      return pick([
        `Done - ${cmd.label ?? "filter updated"}.`,
        `Applied: ${cmd.label ?? "your filter"}. The list just retuned.`,
        `${cmd.label ?? "Filter set"} - results updated.`,
      ]);
    case "start_search":
      return pick([
        "On it - structuring your request and finding every shop around you.",
        "Starting the hunt - reading your request and sweeping the area now.",
        "Let's go - I'm mapping shops near your stay this second.",
      ]);
    case "open_deals":
      return pick([
        "Opening My deals - every hunt, offer and booking in one place.",
        "Here's your deals view - all your hunts and their status together.",
      ]);
    case "open_pricing":
      return pick([
        "Here are the plans - honestly, one good negotiation usually pays for months.",
        "Pulling up pricing - I'll only ever suggest an upgrade if it truly earns its keep.",
      ]);
    case "open_feedback":
      return pickVariant("open_feedback");
    case "clear_search":
      return pick([
        "Sure - confirm in the dialog and I'll wipe this search clean.",
        "One confirmation and I'll clear it - every queued message stops too.",
      ]);
    case "pause_session":
      return pick([
        "Paused. I'll keep every reply but send nothing until you say resume.",
        "Holding everything - replies still land, but I won't message out till you're ready.",
      ]);
    case "resume_session":
      return pick([
        "Back on it - picking the negotiations up where we left off.",
        "Resumed. The agents are moving again.",
      ]);
    case "mass_bargain":
      return ctx.waConnected
        ? pick([
            "Going wide - asking every remaining shop, each with its own wording. The first goes now, the rest follow at a natural pace.",
            "Firing at all the open shops - one message leaves immediately, the others space out so replies keep flowing.",
          ])
        : pick([
            "I'd love to - connect your WhatsApp in Profile first and I'll reach them all.",
            "Almost - link WhatsApp in Profile and this becomes one tap.",
          ]);
    case "open_vendor":
      return pick(["Taking you to that shop's card.", "Here's that shop - opening it now."]);
    case "remember":
      return pick([
        `Noted - I'll keep that in mind this session: "${cmd.note}".`,
        `Locked in: "${cmd.note}". I'll honour it while we hunt.`,
      ]);
    default:
      return pick(["All set.", "Done.", "Handled.", "Taken care of."]);
  }
}

/** Plain-language explainer for "what is a search session?" - no jargon. */
function sessionExplainer(): string {
  return pick([
    "A search session is one hunt from a single search. Every shop I contact, every reply and offer, and your queued messages all belong to that one session - start a new search and a fresh session begins. Your deals page groups everything by session.",
    "Think of a search session as one trip's hunt: it starts when you search, and holds all the shops I message, their replies and your queue. A new search opens a new session, so nothing gets tangled between trips.",
  ]);
}

/** Plain-language explainer for capacity/pacing - outcomes only, no ban talk. */
function capacityExplainer(ctx: WillContext): string {
  const c = planCapacity(ctx.plan);
  const planName = ctx.plan === "ultra" ? "Ultra" : ctx.plan === "pro" ? "Pro" : "Free";
  return pick([
    `On ${planName} I introduce your WhatsApp to up to ${c.newContacts} new shops every ${c.windowHours} hours. The very first shop is messaged right away and the rest follow at a natural, human pace so shops actually reply. That capacity refreshes continuously - you're never stuck waiting for the next day.`,
    `Your ${planName} plan reaches up to ${c.newContacts} new shops per ${c.windowHours}-hour window. I message the first one immediately, then space the others out like a real person would - it keeps replies coming and your number healthy. As time passes, room for more shops opens up automatically.`,
  ]);
}

export const maxDuration = 60;
