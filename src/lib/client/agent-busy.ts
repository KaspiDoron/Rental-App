// WHO IS HOLDING THIS SHOP - said the same way on every surface.
//
// The Bargain lock exists on two buttons (the card and the thread panel) and
// they must not disagree, so the label lives here rather than in either of
// them. It also has to be TRUE: an edited bargain draft is queued as `custom`,
// which is the traveller's own text, and "your agent is on it" is simply wrong
// about it. The activity rollup carries `own` for exactly this.

export interface AgentPending {
  count: number;
  sending: boolean;
  own?: boolean;
}

/** Is anything in flight to this shop right now? */
export function isAgentBusy(p: AgentPending | undefined): boolean {
  return (p?.count ?? 0) > 0;
}

/** The chip label + icon for a busy shop. `t` is the caller's translator. */
export function agentBusyLabel(
  p: AgentPending | undefined,
  t: (s: string) => string
): string {
  if (p?.sending) return `📤 ${t("Sending now")}`;
  if (p?.own) return `✍️ ${t("Your message is going out")}`;
  return `🤖 ${t("Your agent is on it")}`;
}
