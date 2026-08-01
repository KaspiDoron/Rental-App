// WILL PROMISES MORE THAN WILL DELIVERS.
//
// The command vocabulary offers a dozen actions and the traveller cannot tell
// which of them are wired end to end. Some are: setting a radius, a filter, a
// budget, pausing. Some run through paths still being rebuilt this pass, and a
// confident "Done - pushing every shop now" that changes nothing is worse than
// a refusal, because the traveller stops watching.
//
// So the ACTING half is behind a switch the owner controls from the Key Vault,
// and the GUIDANCE half - status, why, compare, help, navigation - is never
// gated. Will keeps answering questions truthfully whatever the flag says; what
// the flag decides is whether he reaches for the controls himself or tells the
// traveller exactly which button to press.
//
// A flag in app_config rather than a build-time constant, so turning execution
// back on after a fix is a paste in Admin -> Keys, not a redeploy - and turning
// it OFF the moment something regresses in the field is the same paste.

import { parseFlag } from "./config-flags";
import type { WillCommand } from "./will-commands";

/** The owner switch. Default ON - actions work unless the owner says otherwise. */
export const WILL_ACTIONS_KEY = "WILL_ACTIONS";

/**
 * Commands that CHANGE something. Everything not listed here is an answer, a
 * navigation or a clarification, and stays available whatever the flag says.
 */
const ACTING: ReadonlySet<WillCommand["action"]> = new Set([
  "set_radius",
  "set_filter",
  "set_budget",
  "start_search",
  "clear_search",
  "pause_session",
  "resume_session",
  "mass_bargain",
  "remember",
]);

export function isActingCommand(action: string): boolean {
  return ACTING.has(action as WillCommand["action"]);
}

/** Read the switch. Unset or unparseable keeps actions ON. */
export function willActionsEnabled(raw: unknown): boolean {
  return parseFlag(raw, true);
}

/**
 * What to say instead of acting.
 *
 * It names the control the traveller can use RIGHT NOW, because "this is under
 * development" on its own is an apology, not help. One line per action, phrased
 * as directions rather than a limitation.
 */
export function guidanceFor(command: WillCommand): string {
  switch (command.action) {
    case "set_radius":
      return `I'm not moving the search radius myself just yet - use the radius slider at the top of Find Deals and set it to ${command.km} km, and I'll pick up from there.`;
    case "set_filter":
      return `I can't change filters for you at the moment - open Filters under the search bar${
        command.label ? ` and set ${command.label}` : ""
      }, and everything I tell you afterwards will reflect it.`;
    case "set_budget":
      return command.maxPricePerDay === null
        ? "Clear the budget in Filters (leave the max price empty) - I'm not setting it myself right now."
        : `Set the max price to ${command.maxPricePerDay} in Filters - I'm not setting it myself right now.`;
    case "start_search":
      return "Type the ride and the place into the search box and hit the button - I'm not starting searches myself at the moment, but I'll narrate the whole hunt once it's running.";
    case "clear_search":
      return "Clearing a hunt is yours to do - the reset control is next to the search bar. I'll not do it for you, and I would not do it without asking anyway.";
    case "pause_session":
      return "Use Pause in the live status panel - I'm not stopping the agents myself right now. Everything already sent stays sent; nothing new goes out while it's paused.";
    case "resume_session":
      return "Tap Resume in the live status panel and the agents pick up where they left off - I'm not flipping that switch myself at the moment.";
    case "mass_bargain":
      return "Use Bargain with all from the status panel - it shows you exactly which shops it will push before anything goes out. I'm not firing it myself right now.";
    case "remember":
      return "I can't hold standing instructions yet, so I'd rather say so than forget it quietly. Tell me again whenever it matters and I'll factor it into that answer.";
    default:
      return "That one is still being built. Ask me what's happening or why a shop is leading - those I can answer in full.";
  }
}
