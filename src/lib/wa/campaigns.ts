// THE LEVER THAT WAS SOLD AND NEVER BUILT.
//
// `PlanCapacity.concurrentCampaigns` has been in the type since Module 6, with
// a comment explaining it is "a separate, sellable concurrency lever" - and
// nothing has ever read it. Not one call site. A paid tier promised parallel
// hunts and a free account got exactly the same behaviour, because there was no
// notion of a campaign anywhere in the send path to bound.
//
// A CAMPAIGN IS A SEARCH SESSION'S COLD OUTREACH. That is what the traveller
// experiences as "a hunt": one request, one radius, a batch of introductions to
// shops that have never been messaged. Starting a second hunt while the first
// one is still working through its queue is the thing being metered, and the
// search epoch the client already stamps on every card is its natural identity.
//
// The `newContacts` window still bounds TOTAL new shops - this does not replace
// it. Free's whole 10-shop window is consumed by one hunt anyway, which is
// exactly why parallelism is the paid part.
//
// Pure, so the policy can be tested without a database and stated once.

import { PLAN_CAPACITY, type CapacityPlan } from "./capacity";

/** One pending cold-outreach row, reduced to what the policy needs. */
export interface CampaignRow {
  kind?: string | null;
  campaign?: string | number | null;
}

/** Cold introductions only - a reply or a typed message is not a campaign. */
const CAMPAIGN_KINDS = new Set(["rfq"]);

/**
 * The distinct hunts with cold outreach still queued.
 *
 * Rows with no campaign stamp are pre-migration or non-hunt sends; they are
 * counted as ONE anonymous campaign rather than ignored, so an older client
 * cannot slip an unlimited number of parallel hunts past the limit by simply
 * not stamping them.
 */
export function activeCampaigns(rows: CampaignRow[]): Set<string> {
  const out = new Set<string>();
  for (const row of rows) {
    if (!CAMPAIGN_KINDS.has(String(row.kind ?? ""))) continue;
    out.add(campaignKey(row.campaign));
  }
  return out;
}

/** One campaign's stable key. Unstamped rows share the "legacy" bucket. */
export function campaignKey(campaign: string | number | null | undefined): string {
  const s = String(campaign ?? "").trim();
  return s || "legacy";
}

export interface CampaignVerdict {
  allowed: boolean;
  /** How many hunts are already in flight, this one included when allowed. */
  active: number;
  limit: number;
  reason?: string;
}

/**
 * May this send start (or continue) a hunt right now?
 *
 * ADDING TO A HUNT ALREADY IN FLIGHT IS ALWAYS ALLOWED - the shops of one batch
 * arrive one request at a time, and refusing the eleventh shop of a hunt the
 * traveller already started would be a bug wearing a limit's clothes. Only a
 * NEW campaign beyond the plan's concurrency is refused.
 */
export function campaignVerdict(
  plan: CapacityPlan,
  pending: CampaignRow[],
  campaign: string | number | null | undefined
): CampaignVerdict {
  const limit = PLAN_CAPACITY[plan].concurrentCampaigns;
  const active = activeCampaigns(pending);
  const key = campaignKey(campaign);

  if (active.has(key)) {
    return { allowed: true, active: active.size, limit };
  }
  if (active.size < limit) {
    return { allowed: true, active: active.size + 1, limit };
  }
  return {
    allowed: false,
    active: active.size,
    limit,
    reason:
      limit === 1
        ? "Your current hunt is still going out. Wait for it to finish, or upgrade to run more than one at a time."
        : `You already have ${limit} hunts in flight. Wait for one to finish, or upgrade for more.`,
  };
}
