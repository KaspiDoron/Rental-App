// Plain-language dictionary for every metric in the Engine section. Keyed by a
// stable id used both as the InfoTip `id` and to look the copy up. `what` says
// what the number means; `drift` says what to do when it looks wrong. Owner-
// facing, jargon-light - a non-engineer should be able to read the panel.

export interface MetricHelp {
  label: string;
  what: string;
  drift?: string;
}

export const ENGINE_HELP: Record<string, MetricHelp> = {
  // ---- Tier 1: liveness + throughput ----------------------------------------
  turns6h: {
    label: "Turns (6h)",
    what: "How many times the engine answered a shop message in the last 6 hours. One turn = one shop reply the agent read, reasoned about and responded to.",
    drift: "If this is 0 while shops are replying, inbound is not reaching us - open WA doctor and Re-arm.",
  },
  failovers: {
    label: "Failovers",
    what: "Times the fast single-pass engine (ENGINE_V3) could not run and the older graph engine took over as a safety net. Replies still went out.",
    drift: "A few is fine. A steady stream means a provider or the engine is unhealthy - check the provider mix and costs.",
  },
  unverified: {
    label: "Unverified sends",
    what: "Messages we sent to WhatsApp but never got a delivery receipt back for. They may or may not have landed.",
    drift: "A rising count points at the WhatsApp link or Evolution - check WA sockets and the doctor.",
  },
  queue: {
    label: "Queue due / total",
    what: "Outbound messages waiting to send. 'Due' are past their safe-send time and should go out on the next drain; 'total' is everything queued.",
    drift: "If 'due' stays high and never drains, the scheduler/drain is stalled - check the workers.",
  },
  sockets: {
    label: "WA sockets (mirror)",
    what: "How many travellers have a WhatsApp session marked open. This is a durable mirror - it does NOT downgrade the instant a socket drops, so treat it as 'ever linked', not live proof.",
    drift: "Cross-check with the webhook-accepted tile below; that row is the real liveness signal.",
  },
  lastInbound: {
    label: "Last inbound",
    what: "How long ago the newest real shop reply landed in the database.",
    drift: "'-' or hours-old while shops are actively replying = inbound is broken. Re-arm the webhook.",
  },
  webhookAccepted: {
    label: "Webhook accepted",
    what: "How long ago Evolution successfully delivered a webhook to us. This is the true 'inbound is alive' signal.",
    drift: "If this is old but 403s are recent, Evolution holds a stale token - tap Re-arm in WA doctor.",
  },
  webhook403: {
    label: "Webhook 403",
    what: "How long ago we rejected an inbound webhook for a bad token. Occasional 403s are harmless; a recent 403 with NO recent accept means the token is wrong.",
    drift: "Recent 403 + no accept = re-arm the webhook with the current token.",
  },
  socketsStamped: {
    label: "Sockets stamped",
    what: "When the socket mirror above was last written. Old stamp = the 'open' count is stale.",
  },

  // ---- Operations (live 6h, from real offers + message timing) --------------
  opsRealizedMargin: {
    label: "Realized margin",
    what: "The average discount the agents actually landed in the last 6 hours - each offer's final price versus the shop's own list price. This is a real, measured cut, not a market estimate.",
    drift: "A '-' means no offer this window carried a comparable list price yet. A near-zero margin while shops are engaging means the bargaining is not biting - check the move mix.",
  },
  opsShopReply: {
    label: "Shop reply time",
    what: "The typical (median) minutes a shop took to reply to us over the last 6 hours, paired message-by-message. Tells you how alive the market is right now.",
    drift: "Very high means shops are slow or asleep (off-hours); it does not indicate an engine problem on its own.",
  },
  opsVisionAccuracy: {
    label: "Photo price accuracy",
    what: "How often the price we read off a shop's photo matched the price that shop later typed. Most shops answer with a picture of their board, so this is how much of the app's pricing you can actually trust. Only turns where BOTH a photo reading and a typed price exist are scored.",
    drift: "A '-' means no photo reading has been confirmed in text yet. Falling accuracy means the vision chain is misreading boards - check the conflicts, they name both numbers.",
  },
  opsLeverageUse: {
    label: "Leverage used",
    what: "Of the bargains where a real cheaper offer from another shop was available, how often the agent actually named it. This is the single strongest lever we have.",
    drift: "A low number with plenty of opportunities means the rival price is reaching the prompt but not the message - check the post-rails rejections.",
  },

  // ---- Field KPIs (durable, 30-day) -----------------------------------------
  discountMargin: {
    label: "Discount margin",
    what: "Average price cut the agents won versus each shop's list price, over the last 30 days. Higher = harder bargaining.",
    drift: "A sudden drop can mean shops are anchoring high or the bargaining prompts regressed.",
  },
  conversion: {
    label: "Conversion",
    what: "Share of searches that ended in a booking, last 30 days.",
    drift: "Low conversion with healthy offers points at the closing UX, not the engine.",
  },
  escalation: {
    label: "Escalation",
    what: "How often a human took a conversation over instead of the agent, last 30 days.",
    drift: "Rising escalation means the agent is getting stuck - review the turn stream for repeated fallbacks.",
  },
  latency: {
    label: "Response latency",
    what: "How fast the engine composed and sent a reply, p50 (typical) and p95 (slowest 5%), over delivered replies.",
    drift: "High p95 means some replies are slow - usually a slow provider. Check the provider mix.",
  },

  // ---- Tier 2: charts -------------------------------------------------------
  turnsPerHour: {
    label: "Turns per hour",
    what: "Reply volume for each of the last 6 hours, oldest on the left. Shows whether the engine is busy or idle right now.",
    drift: "A cliff to zero marks the moment inbound broke - line it up with the webhook tiles.",
  },
  moveMix: {
    label: "Move mix",
    what: "What the agents actually did across recent turns - bargained, presented an offer, closed, stayed silent. The engine's behaviour at a glance.",
    drift: "Mostly 'silent' or 'present' with little 'bargain' means the agents are being too passive.",
  },
  providerMix: {
    label: "Provider mix",
    what: "Which AI model provider actually answered each turn - groq, gemini, cerebras and the rest of the failover chain. 'mock/local' means no provider answered and the turn fell back to a deterministic template.",
    drift: "A rising 'mock/local' share means keys are missing, rate-limited or timing out. Before this was wired up it read 100% on every turn, including turns a real model composed - if you are looking at old data, that is why.",
  },

  // ---- Tier 3: turn stream --------------------------------------------------
  turnStream: {
    label: "Single-pass turns",
    what: "The live decision log - newest first. Each row is one shop reply the engine answered, with the move it chose, the model route, its private reasoning and the exact wire text. Tap a row to expand the full detail.",
  },
  blackboard: {
    label: "Blackboard",
    what: "The cheapest offer seen so far for each vehicle type across the whole session - the shared 'lowest known price' the agents anchor against when bargaining.",
  },
};
