import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const readCode = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

// THE FIELD FAILURE: "Alerts on" for six days, zero notifications. It is two
// separate bugs wearing one symptom, and each needs its own proof.
//
//   1. The push only ever fired at the END of a successful agent turn, so every
//      reply that parked, offloaded to vision, hit a guard or an LLM outage
//      produced no notification at all.
//   2. The toggle read an ACCOUNT-WIDE row count, so a subscription left on a
//      laptop reported "on" to a phone that held no PushSubscription and could
//      never receive anything.

describe("the notification fires when the message LANDS, not when the agent finishes", () => {
  const ingest = readCode("src/lib/wa/ingest.ts");
  const body = stripComments(ingest);

  it("push is sent from the ingest path, right after the message is stored", () => {
    // Ordering matters: the store must already have happened, so the traveller
    // who opens the app from the notification finds the message there.
    const store = body.indexOf("recordResponseTime");
    const push = body.indexOf("sendPushToUser(email, {\n              title: `${shop} replied`");
    expect(store).toBeGreaterThan(0);
    expect(push).toBeGreaterThan(store);
  });

  it("it never blocks or breaks ingest", () => {
    // Fire-and-forget inside its own try: a push service having a bad minute
    // must not cost us the webhook (Evolution retries a non-2xx, which would
    // re-deliver the whole batch).
    const start = body.lastIndexOf("void (async () => {", body.indexOf("`${shop} replied`"));
    expect(start).toBeGreaterThan(0);
    const block = body.slice(start, body.indexOf("markOpen", start));
    expect(block).toMatch(/sendPushToUser\(email/);
    expect(block).toMatch(/catch \{/);
  });

  it("photos and voice notes say what actually arrived", () => {
    expect(body).toMatch(/hasImage[\s\S]{0,120}Sent a photo/);
    expect(body).toMatch(/hasAudio[\s\S]{0,120}Sent a voice note/);
  });

  it("the buzz is tagged PER SHOP, and the agent turn upgrades that same tag", () => {
    // One tag for the whole app meant shop B's reply silently replaced shop A's
    // unread notification. Per-shop tagging also makes the later "they quoted
    // 250/day" push an UPGRADE of this one rather than a second buzz.
    expect(body).toMatch(/tag: `shop:\$\{from\}`/);
    const loop = stripComments(readCode("src/lib/agent-loop.ts"));
    expect(loop).toMatch(/sendPushCollapsed\([\s\S]{0,400}tag: `shop:\$\{from\}`/);
    // ...and a SAFETY warning keeps its own lane - it must never be collapsed
    // away by an ordinary reply, nor silently replace one.
    expect(loop).toMatch(/tag: `risk:\$\{from\}`/);
  });

  it("the ingest push does NOT spend the traveller's interruption budget", () => {
    // notify/state counts `push-sent` rows to decide whether a further
    // interruption is warranted. Stamping ingest pushes there would suppress
    // the more informative "price landed" upgrade - which costs no extra buzz
    // because it shares the collapse tag.
    expect(body).toMatch(/kind: "push-ingest"/);
    expect(body).not.toMatch(/markPushSent/);
    expect(stripComments(readCode("src/lib/notify/state.ts"))).toMatch(/kind=eq\.push-sent/);
  });
});

describe("a dead subscription is pruned, whichever way the service says so", () => {
  const push = stripComments(readCode("src/lib/push.ts"));

  it("400/401/403 prune too, not only 404/410", () => {
    // After a VAPID rotation the push service answers 400/401/403 - "these keys
    // do not match this subscription". Those rows used to live forever, so the
    // UI counted them as "alerts on" while every send burned on a corpse.
    expect(push).toMatch(
      /code === 400 \|\| code === 401 \|\| code === 403 \|\| code === 404 \|\| code === 410/
    );
    expect(push).toMatch(/sbDelete\(\s*"push_subscriptions"/);
  });

  it("the send reports what happened instead of swallowing it", () => {
    expect(push).toMatch(/Promise<PushOutcome>/);
    expect(push).toMatch(/out\.reason = "vapid-unconfigured"/);
    expect(push).toMatch(/out\.reason = "no-subscriptions"/);
    expect(push).toMatch(/out\.pruned \+= 1/);
    expect(push).toMatch(/out\.delivered \+= 1/);
  });

  it("the collapse path can carry a tag (so an upgrade replaces, not stacks)", () => {
    expect(push).toMatch(/sendPushCollapsed\([\s\S]{0,300}tag\?: string/);
  });
});

describe("the toggle tells THIS phone the truth", () => {
  const hook = stripComments(readCode("src/lib/use-push.ts"));

  it("the server hands over endpoints, not just a count", () => {
    // A count is an account-wide fact. Only the endpoint list can answer the
    // question the device actually has: am I one of them?
    expect(stripComments(readCode("src/app/api/push/subscribe/route.ts"))).toMatch(
      /endpoints,/
    );
    expect(stripComments(readCode("src/lib/push.ts"))).toMatch(
      /export async function subscriptionEndpoints/
    );
  });

  it("the browser's own subscription is reconciled against them", () => {
    expect(hook).toMatch(/pushManager\.getSubscription\(\)/);
    expect(hook).toMatch(/d\.endpoints as string\[\]\)\.includes\(mine!\.endpoint\)/);
    expect(hook).toMatch(/if \(mine && !knownHere\) setState\("stale"\)/);
    expect(hook).toMatch(/else if \(!mine && serverOn\) setState\("on-elsewhere"\)/);
    // "on" now requires BOTH - the account row AND this device's subscription.
    expect(hook).toMatch(/setState\(serverOn && mine \? "on" : "off"\)/);
  });

  it("a VAPID rotation is recoverable without clearing site data", () => {
    // subscribe() throws InvalidStateError while an old subscription with a
    // different applicationServerKey exists, so "Fix alerts on this phone"
    // failed forever. Drop the stale one, then take the new key.
    expect(hook).toMatch(/const old = await reg\.pushManager\.getSubscription\(\)/);
    expect(hook).toMatch(/await old\.unsubscribe\(\)[\s\S]{0,80}subscribe\(\{ userVisibleOnly/);
  });

  it("turning alerts off silences THIS device, not every device", () => {
    expect(hook).toMatch(/body: JSON\.stringify\(endpoint \? \{ endpoint \} : \{\}\)/);
    expect(hook).toMatch(/const disableEverywhere = useCallback/);
  });

  it("an iPad is not told its browser cannot do push", () => {
    // iPadOS 13+ reports itself as a Mac, so /iphone|ipad|ipod/ missed every
    // modern iPad and sent it to the terminal "unsupported" state instead of
    // the Add-to-Home-Screen path where push actually works.
    expect(hook).toMatch(/Macintosh\/i\.test\(ua\) && \(navigator\.maxTouchPoints \?\? 0\) > 1/);
  });
});

describe("both alert surfaces refuse to claim more than they can do", () => {
  const chip = stripComments(readCode("src/components/AlertsChip.tsx"));
  const toggle = stripComments(readCode("src/components/AlertsToggle.tsx"));

  it("the chip never renders the new states as plain 'Alerts on'", () => {
    expect(chip).toMatch(/state === "on-elsewhere"[\s\S]{0,80}Alerts on another device/);
    expect(chip).toMatch(/state === "stale"[\s\S]{0,80}Alerts need fixing on this phone/);
    // ...and neither is treated as ON, so tapping registers this device.
    expect(chip).toMatch(/const on = state === "on";/);
  });

  it("the toggle offers the one-tap repair and a real test send", () => {
    expect(toggle).toMatch(/Fix alerts on this phone/);
    expect(toggle).toMatch(/Send test alert/);
    expect(toggle).toMatch(/disableEverywhere\(\)/);
  });

  it("the test send reports per-device truth, never a cheerful lie", () => {
    const hook = stripComments(readCode("src/lib/use-push.ts"));
    expect(hook).toMatch(/fetch\("\/api\/push\/test", \{ method: "POST" \}\)/);
    expect(hook).toMatch(/Nothing was accepted/);
    const route = stripComments(readCode("src/app/api/push/test/route.ts"));
    expect(route).toMatch(/getSession\(\)/);
    expect(route).toMatch(/status: 401/);
    // Endpoints identify a device; only the OUTCOME crosses the wire.
    expect(route).toMatch(/results: outcome\.results\.map/);
    expect(route).not.toMatch(/endpoint: r\.endpoint/);
  });
});

describe("the doctor can tell a silent phone from a broken webhook", () => {
  it("the report carries a push section with the VAPID pair verdict", () => {
    const route = stripComments(readCode("src/app/api/admin/wa-doctor/route.ts"));
    expect(route).toMatch(/pushDiagnostics\(email\)/);
    expect(route).toMatch(/\n    push,\n/);
    const push = stripComments(readCode("src/lib/push.ts"));
    // "mismatched" is the case no other surface can see: both keys present, so
    // everything reports configured, but nothing can ever be delivered.
    expect(push).toMatch(/vapidPairMatches\(pub, priv\)\s*\?\s*"ok"\s*:\s*"mismatched"/);
    expect(push).toMatch(/kind=eq\.push-ingest/);
  });

  it("device endpoints never reach the admin UI - only their hosts", () => {
    const push = stripComments(readCode("src/lib/push.ts"));
    expect(push).toMatch(/new URL\(e\)\.host/);
    const card = stripComments(readCode("src/components/admin/WaDoctorCard.tsx"));
    expect(card).toMatch(/services: string\[\]/);
    expect(card).not.toMatch(/endpoints:/);
  });
});

describe("the service worker collapses per shop and still wakes an open tab", () => {
  const sw = stripComments(readCode("public/sw.js"));

  it("the payload tag wins over the old single global tag", () => {
    expect(sw).toMatch(/tag: data\.tag \|\| "wheeldeal-reply"/);
    expect(sw).toMatch(/renotify: true/);
  });

  it("an open app still refreshes immediately (no 6-15s poll desync)", () => {
    expect(sw).toMatch(/type: "wd-refresh", reason: "push"/);
  });
});
