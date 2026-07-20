// Module-7 E2E: fire synthetic Evolution webhooks at the REAL gateway + workers
// and assert the whole pipeline. Self-skips when no Redis is reachable so the
// default `vitest run` (which has no Redis) stays green - the live run is
// `npm run test:e2e` with a local redis on TEST_REDIS_URL.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer } from "node:net";
import { Queue } from "bullmq";
import {
  MockEvolutionServer,
  MockSupabaseServer,
  computeWebhookToken,
  textUpsert,
  imageUpsert,
  connectionUpdate,
  postWebhook,
  startGateway,
  startWorkers,
  redisClient,
  redisReachable,
  waitFor,
  type ServiceHandle,
} from "./mockWebhookHarness";

const REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://127.0.0.1:6399";
const SESSION_SECRET = "e2e-session-secret-32bytes-long!!"; // >=16 -> real token path
const RUN_DB = process.env.RUN_DB_E2E === "1";

function freePort(): Promise<number> {
  return new Promise((res) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => res(p));
    });
  });
}

function redisConn() {
  const u = new URL(REDIS_URL);
  return { host: u.hostname, port: Number(u.port || 6379) };
}

// Probe once at collection time; the whole suite self-skips with no Redis so the
// default `vitest run` stays green.
const REDIS_UP = await redisReachable(REDIS_URL);

describe.skipIf(!REDIS_UP)("Module 7 - E2E mock webhook pipeline", () => {
  let evo: MockEvolutionServer;
  let gateway: ServiceHandle;
  let workers: ServiceHandle;
  let gatewayUrl: string;
  let token: string;
  const INSTANCE = "wd-e2e-instance";

  beforeAll(async () => {
    // fresh redis so dedup/queue assertions are deterministic
    const rc = await redisClient(REDIS_URL);
    await rc.flushdb();
    await rc.quit();

    evo = await new MockEvolutionServer().start();
    const port = await freePort();
    gatewayUrl = `http://127.0.0.1:${port}`;
    token = computeWebhookToken(SESSION_SECRET)!;

    const env = {
      REDIS_URL,
      SESSION_SECRET,
      EVOLUTION_API_URL: evo.url,
      EVOLUTION_API_KEY: "mock-key",
      GATEWAY_PORT: String(port),
      LOG_LEVEL: "warn",
    };
    gateway = await startGateway(env);
    workers = await startWorkers(env);
    // Settle so the incoming worker is fully subscribed before the first post.
    await new Promise((r) => setTimeout(r, 2000));
  }, 60_000);

  afterAll(async () => {
    await workers?.stop();
    await gateway?.stop();
    await evo?.close();
  });

  it("rejects a webhook with a wrong or missing token (403)", async () => {
    const body = textUpsert({ instance: INSTANCE, fromDigits: "63900000001", providerId: "tok-1", text: "hi" });
    expect((await postWebhook({ gatewayUrl, token: "wrong-token", body })).status).toBe(403);
    expect((await postWebhook({ gatewayUrl, token: null, body })).status).toBe(403);
  });

  it("accepts a valid token and enqueues the inbound", async () => {
    const body = textUpsert({ instance: INSTANCE, fromDigits: "63900000002", providerId: "acc-1", text: "how much per day?" });
    const r = await postWebhook({ gatewayUrl, token, body });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(r.json.dedup).toBeUndefined();
  });

  it("SETNX-dedups a repeated provider message id (single enqueue)", async () => {
    const body = textUpsert({ instance: INSTANCE, fromDigits: "63900000003", providerId: "dup-1", text: "still there?" });
    const first = await postWebhook({ gatewayUrl, token, body });
    const second = await postWebhook({ gatewayUrl, token, body });
    expect(first.json.dedup).toBeUndefined();
    expect(second.json.dedup).toBe(true); // Redis SETNX caught the duplicate
  });

  it("the incoming worker consumes the enqueued job to completion", async () => {
    const queue = new Queue("incoming_message_queue", { connection: redisConn() });
    try {
      const providerId = "consume-1";
      await postWebhook({
        gatewayUrl,
        token,
        body: textUpsert({ instance: INSTANCE, fromDigits: "63900000004", providerId, text: "price?" }),
      });
      const job = await waitFor(async () => (await queue.getJob(providerId)) ?? null, { timeoutMs: 15000 });
      await waitFor(async () => (await job.getState()) === "completed", { timeoutMs: 15000 });
      expect(await job.getState()).toBe("completed");
    } finally {
      await queue.close();
    }
  });

  it("handles connection lifecycle events without error (open + logout close)", async () => {
    const open = await postWebhook({ gatewayUrl, token, body: connectionUpdate({ instance: INSTANCE, state: "open" }) });
    const close = await postWebhook({
      gatewayUrl,
      token,
      body: connectionUpdate({ instance: INSTANCE, state: "close", reason: "logged out" }),
    });
    expect(open.status).toBe(200);
    expect(close.status).toBe(200);
  });

});

// ---- Tier 2 (opt-in): DB-backed core-engine processing + reply production ----
// A SIBLING suite (not nested) so the Tier-1 workers are torn down before this
// boots - otherwise two worker pools race the one shared incoming queue and the
// no-DB pool would consume the DB job. Runs only with RUN_DB_E2E=1 and needs a
// stable box (a seeded MockSupabase answers the ingest-gate queries; the full
// engine then persists the inbound and produces an outbound reply - queued to
// wa_outbox for paced delivery, or sent inline). The wire-send itself is the
// outbound worker / drain's job, proven by the live module smokes.
describe.skipIf(!REDIS_UP || !RUN_DB)("Module 7 - DB-backed engine + reply (RUN_DB_E2E=1)", () => {
  let evo: MockEvolutionServer;
  let supa: MockSupabaseServer;
  let gateway: ServiceHandle;
  let workers: ServiceHandle;
  let gatewayUrl: string;
  let token: string;
  const INSTANCE = "wd-e2e-db-instance";
  const SHOP = "63911111111";
  const OWNER = "owner@e2e.test";

  beforeAll(async () => {
    const rc = await redisClient(REDIS_URL);
    await rc.flushdb();
    await rc.quit();

    evo = await new MockEvolutionServer().start();
    supa = await new MockSupabaseServer({
      instanceEmail: { [INSTANCE]: OWNER },
      vendorThreads: [{ toNumber: SHOP, senderEmail: OWNER, ageMs: 60_000 }],
    }).start();
    const port = await freePort();
    gatewayUrl = `http://127.0.0.1:${port}`;
    token = computeWebhookToken(SESSION_SECRET)!;
    const env = {
      REDIS_URL,
      SESSION_SECRET,
      EVOLUTION_API_URL: evo.url,
      EVOLUTION_API_KEY: "mock-key",
      SUPABASE_URL: supa.url,
      SUPABASE_SERVICE_ROLE_KEY: "mock-service-role",
      GATEWAY_PORT: String(port),
      LOG_LEVEL: "warn",
    };
    gateway = await startGateway(env);
    workers = await startWorkers(env);
    // Settle: give the incoming worker a moment to fully subscribe before the
    // first post (avoids a first-job consumption race in the spawned process).
    await new Promise((r) => setTimeout(r, 3000));
  }, 60_000);

  afterAll(async () => {
    await workers?.stop();
    await gateway?.stop();
    await supa?.close();
    await evo?.close();
  });

  it("an inbound from a seeded vendor thread drives the full engine to persist + produce an outbound reply", async () => {
    await postWebhook({
      gatewayUrl,
      token,
      body: textUpsert({ instance: INSTANCE, fromDigits: SHOP, providerId: "deliver-1", text: "350 per day" }),
    });
    // 1. The inbound is persisted, scoped to the receiver (ingest passed the
    //    vendor-thread gate and reached the DB write).
    await waitFor(async () => supa.insertsFor("whatsapp_messages").length > 0, { timeoutMs: 25000 });
    // 2. The core engine ran and produced an outbound reply - either sent inline
    //    (captured at mock Evolution /message/sendText) OR queued for paced
    //    delivery (wa_outbox row). The wire-send itself is the outbound
    //    worker / drain's job, covered by the live module smokes; here we prove
    //    the engine turned the inbound into an outbound reply end-to-end.
    const reply = await waitFor(
      async () => evo.sent.length > 0 || supa.insertsFor("wa_outbox").length > 0,
      { timeoutMs: 25000 }
    );
    expect(reply).toBe(true);
  }, 80_000);
});
