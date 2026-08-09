// What a held lead says when its agency finally opens the window.
//
// The free-form lane has NO content restrictions - no template, no review, no
// category - which is exactly where the informal register the owner asked for
// becomes available. "Hey, got someone looking for a scooter for 4 days, can
// you message them?" is entirely sendable here, and since the service-window
// flush carries most of the traffic, most of what we send can be written this
// way. The template is only ever the first contact with a given agency in a day.
//
// It is worth being precise about what this does and does not buy, because the
// distinction was researched and the answer is uncomfortable. It does NOT make
// the account look like a person: an API-connected number renders in the
// recipient's client with business-account treatment we do not control, the
// display name is a Meta-certified string that cannot be cycled, and attempting
// concealment on a rented WABA is how the reseller terminates us. What it does
// buy is TONE - a short, human, specific message instead of a form letter - and
// tone is the part that was actually moving reply rate all along.

import type { Lead } from "./leads";

export interface HeldRender {
  vehicle: string;
  dates: string;
  language?: string;
  freeformText: string;
  agencyName?: string;
}

/**
 * Default renderer for a held lead.
 *
 * Deliberately plain and specific rather than clever: a named vehicle and real
 * dates are what make a message answerable, and Part 5.12 found that an
 * unanswerable opener is read as reseller fishing - the exact message people
 * block rather than reply to. That finding does not stop applying because the
 * sender changed.
 */
export function renderHeldHandoff(lead: Lead): HeldRender {
  const shop = lead.agency_name?.trim();
  const hello = shop ? `Hi ${shop} - ` : "Hi - ";
  return {
    vehicle: "vehicle",
    dates: "",
    agencyName: lead.agency_name ?? undefined,
    freeformText:
      `${hello}we have a customer looking to rent. ` +
      `Could you message them directly to share your prices? Thanks!`,
  };
}

/**
 * What the agency's chat with the traveller opens pre-filled.
 *
 * Authored by us on purpose. When that message lands on the traveller's phone it
 * carries a phrase our ingest can recognise, which is what covers the common
 * case of an agency replying from a staff mobile rather than the number we
 * templated - tail matching alone would miss it entirely.
 */
export function prefilledOpener(agencyName?: string | null): string {
  const who = agencyName?.trim();
  return who
    ? `Hi, this is ${who} - you were looking to rent a vehicle?`
    : "Hi, you were looking to rent a vehicle?";
}
