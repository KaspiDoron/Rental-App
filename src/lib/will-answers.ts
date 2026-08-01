// Server-composed answers for Will's question intents. Deterministic
// templates first (they always work, keyless); the /api/will route may ask
// the LLM to rewrite them warmly, but the FACTS always come from here.

import "server-only";
import { sbSelect } from "./runtime-config";
import { senderSafety } from "./wa-guard";
import { topVendors, type WillContext } from "./will-commands";

function money(v: number, cur?: string): string {
  return `${v}${cur ? " " + cur : ""}`;
}

/** "What's happening right now?" - live truth across shops. */
export async function composeStatus(email: string, ctx: WillContext): Promise<string> {
  const enc = encodeURIComponent(email);
  const [outbox, wakeups, safety] = await Promise.all([
    sbSelect<{ id: number; not_before: string; meta: { kind?: string; reason?: string } | null }>(
      "wa_outbox",
      `select=id,not_before,meta&sender_key=eq.${enc}&order=not_before.asc&limit=20`
    ).catch(() => []),
    sbSelect<{ not_before: string; payload: { vendorName?: string; reason?: string } | null }>(
      "graph_wakeups",
      // EXACT ownership match on the stamped column, not a `thread_key=like.`
      // wildcard that could read another user's wakeup (a `_` in the email is a
      // single-char SQL wildcard). Unstamped legacy rows are hidden by design.
      `select=not_before,payload&user_email=eq.${encodeURIComponent(
        email
      )}&kind=eq.tick&order=not_before.asc&limit=3`
    ).catch(() => []),
    senderSafety(email).catch(() => null),
  ]);

  const bits: string[] = [];
  // A PRICE FOR A DIFFERENT BIKE IS NOT AN OFFER. The status line reported the
  // cheapest number on the board as "best so far" without ever checking what it
  // was FOR - so a shop that had quoted an e-bike against a 125cc request, or
  // one that had said it has nothing available, led the answer.
  const priced = ctx.vendors.filter(
    (v) => (v.pricePerDay ?? 0) > 0 && !v.outOfStock && v.vehicleStatus !== "wrong-vehicle"
  );
  if (priced.length > 0) {
    const best = priced.sort((a, b) => (a.pricePerDay ?? 0) - (b.pricePerDay ?? 0))[0];
    // Has anyone actually come DOWN? The single most-asked question, and the
    // opening quote was in the snapshot all along.
    const moved =
      best.openingPricePerDay && best.openingPricePerDay > (best.pricePerDay ?? 0)
        ? ` (down from ${money(best.openingPricePerDay, best.currency)})`
        : "";
    bits.push(
      `${priced.length} offer${priced.length === 1 ? "" : "s"} in - best so far is ${
        best.name
      } at ${money(best.pricePerDay!, best.currency)}/day${moved}`
    );
  } else if (ctx.vendors.length > 0) {
    bits.push(`no prices yet from the ${ctx.vendors.length} shops I'm working`);
  }
  const talking = ctx.vendors.filter((v) =>
    ["rfq-sent", "awaiting-response", "negotiating"].includes(v.stage ?? "")
  ).length;
  if (talking > 0) bits.push(`${talking} conversation${talking === 1 ? "" : "s"} open`);
  if (outbox.length > 0) {
    // Answer "when will my message send?" HONESTLY, from the real not_before -
    // the next one's time, or "held for opening hours" when that is the reason.
    const nextDue = outbox
      .map((r) => ({ at: Date.parse(r.not_before), reason: r.meta?.reason ?? "" }))
      .filter((r) => Number.isFinite(r.at))
      .sort((a, b) => a.at - b.at)[0];
    const heldForHours = nextDue && /hour|open/i.test(nextDue.reason);
    const clock =
      nextDue && nextDue.at > Date.now()
        ? new Date(nextDue.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
        : null;
    const noun = `${outbox.length} message${outbox.length === 1 ? "" : "s"} queued`;
    bits.push(
      heldForHours
        ? `${noun}, held for the shop's opening hours`
        : clock
          ? `${noun} - the next goes out around ${clock}`
          : `${noun}, sending at the next safe slot`
    );
  }
  const wait = wakeups.find((w) => Date.parse(w.not_before) > Date.now());
  if (wait) {
    const at = new Date(wait.not_before).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    bits.push(
      `I'm deliberately waiting${wait.payload?.vendorName ? ` on ${wait.payload.vendorName}` : ""} until ${at} - answering instantly weakens our position`
    );
  }
  if (safety && safety.state !== "healthy") {
    bits.push(
      safety.state === "pacing"
        ? "sends are pacing at a safe human rhythm"
        : safety.state === "disconnected"
          ? "your WhatsApp link is DOWN - shop replies can't reach me until you reconnect in Profile"
          : safety.state === "attention"
            ? "a few messages hit a snag in the last day - the activity feed has the details"
            : "sending is on a protective pause for your number right now"
    );
  }
  // THE THINGS WAITING ON THE TRAVELLER, which Will never mentioned because the
  // snapshot did not carry them - so "what's happening?" answered about the
  // system and never about the decision sitting in front of them.
  const waitingOnYou = ctx.vendors.filter((v) => v.alternativeOffered);
  if (waitingOnYou.length > 0) {
    bits.push(
      waitingOnYou.length === 1
        ? `${waitingOnYou[0].name} has offered a DIFFERENT vehicle and I've paused that thread until you say yes or no`
        : `${waitingOnYou.length} shops have offered a different vehicle - those threads are paused for your call`
    );
  }
  const gone = ctx.vendors.filter((v) => v.outOfStock);
  if (gone.length > 0) {
    bits.push(
      `${gone.length} shop${gone.length === 1 ? " has" : "s have"} nothing available right now`
    );
  }
  const unconfirmed = ctx.vendors.filter(
    (v) => (v.pricePerDay ?? 0) > 0 && v.vehicleStatus === "needs-confirmation"
  );
  if (unconfirmed.length > 0) {
    bits.push(
      `${unconfirmed.length} price${unconfirmed.length === 1 ? " is" : "s are"} still waiting on the shop to confirm which vehicle it covers`
    );
  }
  if (ctx.paused) bits.push("the session is PAUSED on your orders - say 'resume' and I'm back on it");
  if (bits.length === 0) {
    return ctx.phase === "idle"
      ? "Nothing running yet - tell me what you want to rent and I'll get to work."
      : "All quiet this second - shops have been asked and I'm watching for replies. You'll feel it the moment one lands.";
  }
  return bits.join(". ") + ".";
}

/** "Why was this rental selected / why this move?" */
export async function composeWhy(email: string, ctx: WillContext): Promise<string> {
  // Same exclusion as the status line: a price for a vehicle the traveller did
  // not ask for cannot justify anything, and a shop with nothing in stock is
  // not leading.
  const priced = ctx.vendors.filter(
    (v) => (v.pricePerDay ?? 0) > 0 && !v.outOfStock && v.vehicleStatus !== "wrong-vehicle"
  );
  const parts: string[] = [];
  if (priced.length > 0) {
    const sorted = [...priced].sort((a, b) => (a.pricePerDay ?? 0) - (b.pricePerDay ?? 0));
    const best = sorted[0];
    const second = sorted[1];
    parts.push(
      `${best.name} leads at ${money(best.pricePerDay!, best.currency)}/day` +
        (second
          ? ` - ${money((second.pricePerDay ?? 0) - (best.pricePerDay ?? 0), best.currency)}/day cheaper than the next option (${second.name})`
          : "") +
        (best.verified ? ", and the shop confirmed it in writing" : ", though it still needs the shop's written confirmation")
    );
    // WHAT THE HAGGLING ACTUALLY ACHIEVED. The opening quote was in the
    // snapshot and the answer never used it, so "why this one?" could not say
    // the one thing the product exists to do.
    if (best.openingPricePerDay && best.openingPricePerDay > (best.pricePerDay ?? 0)) {
      parts.push(
        `They opened at ${money(best.openingPricePerDay, best.currency)}/day - I've taken ${money(
          best.openingPricePerDay - (best.pricePerDay ?? 0),
          best.currency
        )} off that`
      );
    }
  }
  // A CHEAPER NUMBER THAT IS NOT AN ANSWER. When a shop quoted less for a
  // different vehicle, the old answer either used it or silently dropped it -
  // both leave the traveller wondering why the obvious cheapest is not winning.
  const wrongVehicle = ctx.vendors.filter(
    (v) => v.vehicleStatus === "wrong-vehicle" && (v.pricePerDay ?? 0) > 0
  );
  if (wrongVehicle.length > 0) {
    const cheapest = [...wrongVehicle].sort((a, b) => (a.pricePerDay ?? 0) - (b.pricePerDay ?? 0))[0];
    parts.push(
      `I'm NOT counting ${cheapest.name}'s ${money(
        cheapest.pricePerDay!,
        cheapest.currency
      )}/day - that quote is for a different vehicle than you asked for`
    );
  }
  // Latest persisted director reasoning - the real "why" from the live engine.
  const rows = await sbSelect<{ reasoning: string | null; vendor_name: string | null }>(
    "agent_traces",
    `select=reasoning,vendor_name&user_email=eq.${encodeURIComponent(
      email
    )}&stage=eq.director&order=created_at.desc&limit=1`
  ).catch(() => []);
  if (rows[0]?.reasoning) {
    parts.push(
      `My latest call${rows[0].vendor_name ? ` at ${rows[0].vendor_name}` : ""}: ${rows[0].reasoning.slice(0, 200)}`
    );
  }
  if (parts.length === 0) {
    return "No offers to justify yet - once prices land, tap 'Why?' on any shop card and I'll walk you through every move.";
  }
  return parts.join(". ") + ". Tap 'Why?' on a shop card to see the full decision ladder.";
}

/** "Compare the top options" - facts for the CompareSheet + a text summary. */
export function composeCompare(ctx: WillContext, n: number): { text: string; vendorIds: string[] } {
  const tops = topVendors(ctx, Math.min(Math.max(n, 2), 3)).filter((v) => (v.pricePerDay ?? 0) > 0);
  if (tops.length < 2) {
    return {
      text: "I need at least two priced offers to compare - right now there " +
        (tops.length === 1 ? "is only one" : "are none") +
        ". Want me to push more shops for prices?",
      vendorIds: [],
    };
  }
  const lines = tops.map(
    (v, i) =>
      `${i + 1}. ${v.name}: ${money(v.pricePerDay!, v.currency)}/day${v.verified ? " (confirmed)" : ""}`
  );
  return {
    text: `Here are your top ${tops.length} side by side - ${lines.join(" · ")}. Opening the comparison now.`,
    vendorIds: tops.map((v) => v.id),
  };
}
