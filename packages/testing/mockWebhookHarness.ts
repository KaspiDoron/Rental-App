// @wheeldeal/testing - the Module-7 E2E mock-webhook harness.
//
// Fires synthetic Evolution webhooks at the REAL apps/gateway ingress and lets a
// test assert the whole pipeline end-to-end with NO live WhatsApp traffic:
//   token gate (403) -> Redis SETNX dedup -> BullMQ enqueue -> worker consume ->
//   core engine turn -> outbound delivery.
//
// The one hard architectural fact this harness is built around: there is NO
// in-process send seam across the gateway/worker process boundary - every send
// funnels through sendFromUser -> Evolution HTTP (/message/sendText). So the
// ONLY capture point for "final delivery" is the Evolution base URL. This module
// stands up a MockEvolutionServer and the test points EVOLUTION_API_URL at it,
// which BOTH un-403s the webhook token gate (getHosts() becomes non-empty) AND
// records every outbound send. A MockSupabaseServer answers the two ingest-gate
// queries so the DB-backed "core engine -> delivery" tier can run hermetically.
//
// Everything here is plain Node (http, child_process) + the root's ioredis and
// bullmq - no new dependency.

import { createHash } from "node:crypto";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");

// ---------------------------------------------------------------------------
// Token - mirrors src/lib/evolution.ts webhookToken() exactly.
// ---------------------------------------------------------------------------

/** The `?token=` the gateway expects for a given SESSION_SECRET. Mirrors
 * webhookToken(): sha256("wd-webhook:"+secret).slice(0,32), with the dev-only
 * fallback when the secret is <16 chars and NODE_ENV!=="production". */
export function computeWebhookToken(sessionSecret: string | undefined, nodeEnv = process.env.NODE_ENV): string | null {
  if (!sessionSecret || sessionSecret.length < 16) {
    if (nodeEnv === "production") return null;
    return createHash("sha256").update("wd-webhook:dev-only").digest("hex").slice(0, 32);
  }
  return createHash("sha256").update(`wd-webhook:${sessionSecret}`).digest("hex").slice(0, 32);
}

// ---------------------------------------------------------------------------
// Typed Evolution webhook payload builders
// ---------------------------------------------------------------------------

export interface UpsertOpts {
  instance: string;
  /** The shop's WhatsApp digits (no @suffix). */
  fromDigits: string;
  /** Provider message id - the Redis SETNX + BullMQ jobId dedup key. */
  providerId: string;
  pushName?: string;
  fromMe?: boolean;
}

export interface EvolutionWebhookBody {
  event: string;
  instance: string;
  data: unknown[];
}

function keyFor(o: UpsertOpts) {
  return { id: o.providerId, remoteJid: `${o.fromDigits}@s.whatsapp.net`, fromMe: o.fromMe ?? false };
}

/** A plain text inbound ("messages.upsert" with a conversation message). */
export function textUpsert(o: UpsertOpts & { text: string }): EvolutionWebhookBody {
  return {
    event: "messages.upsert",
    instance: o.instance,
    data: [{ key: keyFor(o), pushName: o.pushName ?? "Shop", message: { conversation: o.text } }],
  };
}

/** An image inbound - carries the Baileys imageMessage descriptor (the base64
 * itself is fetched on demand from /chat/getBase64FromMediaMessage). */
export function imageUpsert(o: UpsertOpts & { caption?: string; mimetype?: string }): EvolutionWebhookBody {
  return {
    event: "messages.upsert",
    instance: o.instance,
    data: [
      {
        key: keyFor(o),
        pushName: o.pushName ?? "Shop",
        message: {
          imageMessage: {
            caption: o.caption ?? "",
            mimetype: o.mimetype ?? "image/jpeg",
            mediaKey: "bW9jay1tZWRpYS1rZXk=",
            url: "https://mmg.whatsapp.net/mock",
            directPath: "/mock/path",
          },
        },
      },
    ],
  };
}

/** A voice-note inbound (audio/ogg opus). */
export function audioUpsert(o: UpsertOpts): EvolutionWebhookBody {
  return {
    event: "messages.upsert",
    instance: o.instance,
    data: [
      {
        key: keyFor(o),
        pushName: o.pushName ?? "Shop",
        message: {
          audioMessage: { mimetype: "audio/ogg; codecs=opus", mediaKey: "bW9jay1rZXk=", seconds: 3 },
        },
      },
    ],
  };
}

/** A connection lifecycle event ("connection.update"). */
export function connectionUpdate(o: { instance: string; state: "open" | "close" | "connecting"; reason?: string }): EvolutionWebhookBody {
  return {
    event: "connection.update",
    instance: o.instance,
    data: [{ state: o.state, ...(o.reason ? { statusReason: o.reason } : {}) }],
  };
}

/** A delivery/read receipt ("messages.update"). */
export function messagesUpdate(o: { instance: string; fromDigits: string; providerId: string; status: string; fromMe?: boolean }): EvolutionWebhookBody {
  return {
    event: "messages.update",
    instance: o.instance,
    data: [{ key: { id: o.providerId, remoteJid: `${o.fromDigits}@s.whatsapp.net`, fromMe: o.fromMe ?? true }, update: { status: o.status } }],
  };
}

// ---------------------------------------------------------------------------
// POST a webhook at the gateway
// ---------------------------------------------------------------------------

export interface WebhookResult {
  status: number;
  json: any;
}

export async function postWebhook(opts: {
  gatewayUrl: string;
  token?: string | null;
  body: EvolutionWebhookBody;
}): Promise<WebhookResult> {
  const url = new URL("/api/webhooks/evolution", opts.gatewayUrl);
  if (opts.token != null) url.searchParams.set("token", opts.token);
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(opts.body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

export async function waitFor<T>(
  poll: () => Promise<T | null | undefined | false>,
  { timeoutMs = 15000, everyMs = 100 }: { timeoutMs?: number; everyMs?: number } = {}
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await poll();
    if (v) return v as T;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => res(b));
  });
}

function listen(server: Server): Promise<number> {
  return new Promise((res) => server.listen(0, "127.0.0.1", () => res((server.address() as { port: number }).port)));
}

// ---------------------------------------------------------------------------
// MockEvolutionServer - answers the Evolution endpoints + captures sends
// ---------------------------------------------------------------------------

export interface CapturedSend {
  instance: string;
  number: string;
  text: string;
  delay?: number;
  atMs: number;
}

export class MockEvolutionServer {
  readonly sent: CapturedSend[] = [];
  private server: Server;
  private port = 0;
  /** Optional override of the getBase64 media reply (Tier-2 image turns). */
  base64Reply: { base64: string; mimetype: string } = {
    // 1x1 transparent PNG
    base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    mimetype: "image/png",
  };

  constructor() {
    this.server = createServer((req, res) => this.handle(req, res));
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async start(): Promise<this> {
    this.port = await listen(this.server);
    return this;
  }

  async close(): Promise<void> {
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  /** Resolve when a captured send matches `pred` (polls the capture buffer). */
  waitForSend(pred: (s: CapturedSend) => boolean, timeoutMs = 15000): Promise<CapturedSend> {
    return waitFor(async () => this.sent.find(pred), { timeoutMs });
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", this.url);
    const p = url.pathname;
    const json = (code: number, obj: unknown) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };

    // GET /instance/connectionState/:instance
    if (req.method === "GET" && p.startsWith("/instance/connectionState/")) {
      return json(200, { instance: { state: "open" } });
    }
    // GET /instance/fetchInstances[?instanceName=]
    if (req.method === "GET" && p.startsWith("/instance/fetchInstances")) {
      const name = url.searchParams.get("instanceName") ?? "wd-mock";
      return json(200, [{ name, connectionStatus: "open" }]);
    }
    // GET /instance/connect/:instance
    if (req.method === "GET" && p.startsWith("/instance/connect/")) {
      return json(200, { instance: { state: "open" } });
    }
    const body = req.method === "POST" ? await readBody(req) : "";
    const parsed = body ? safeJson(body) : {};

    // POST /message/sendText/:instance  <-- the outbound capture point
    if (req.method === "POST" && p.startsWith("/message/sendText/")) {
      const instance = p.split("/").pop() ?? "";
      this.sent.push({
        instance,
        number: String(parsed?.number ?? ""),
        text: String(parsed?.text ?? ""),
        delay: parsed?.delay,
        atMs: Date.now(),
      });
      return json(200, { key: { id: `mock-${this.sent.length}` } });
    }
    // POST /chat/sendPresence/:instance
    if (req.method === "POST" && p.startsWith("/chat/sendPresence/")) return json(200, { ok: true });
    // POST /chat/getBase64FromMediaMessage/:instance
    if (req.method === "POST" && p.startsWith("/chat/getBase64FromMediaMessage/")) {
      return json(200, this.base64Reply);
    }
    // POST /instance/create  and any logout/delete
    if (req.method === "POST" && p.startsWith("/instance/create")) return json(201, { instance: { state: "close" } });
    // Everything else: be lenient (host-health probes, etc.).
    return json(200, { ok: true });
  }
}

function safeJson(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// MockSupabaseServer - a NARROW PostgREST stub for the DB-backed tier.
//
// Answers exactly the reads the ingest gate makes (emailForInstance +
// isVendorThread) and the config loader (app_config -> [] so getConfig falls
// back to process.env), records inserts, and returns [] for everything else so
// the engine's many optional reads degrade to their empty-DB defaults. This is
// NOT a general Supabase - it is scoped to what the inbound->delivery path
// touches, which is enough to prove "core engine processing -> final delivery".
// ---------------------------------------------------------------------------

export interface SupabaseSeed {
  /** instance_name -> owner email (wa_sessions). */
  instanceEmail: Record<string, string>;
  /** A recent outbound RFQ anchor per shop number so isVendorThread passes. */
  vendorThreads: { toNumber: string; senderEmail: string; ageMs?: number }[];
}

export class MockSupabaseServer {
  readonly inserts: { table: string; rows: any[] }[] = [];
  private server: Server;
  private port = 0;

  constructor(private seed: SupabaseSeed) {
    this.server = createServer((req, res) => this.handle(req, res));
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async start(): Promise<this> {
    this.port = await listen(this.server);
    return this;
  }

  async close(): Promise<void> {
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  insertsFor(table: string): any[] {
    return this.inserts.filter((i) => i.table === table).flatMap((i) => i.rows);
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", this.url);
    // /rest/v1/<table>?<query>
    const table = url.pathname.replace(/^\/rest\/v1\//, "").split("?")[0];
    const q = url.searchParams;
    if (process.env.MOCK_DEBUG) process.stderr.write(`[supa] ${req.method} ${table} ${url.search}\n`);
    const send = (code: number, obj: unknown) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };

    if (req.method === "POST" || req.method === "PATCH") {
      const raw = await readBody(req);
      const parsed = safeJson(raw);
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      if (req.method === "POST") this.inserts.push({ table, rows });
      return send(201, rows);
    }
    if (req.method === "DELETE") return send(200, []);

    // GET reads
    if (table === "app_config") return send(200, []); // -> getConfig falls back to process.env

    if (table === "wa_sessions") {
      // emailForInstance: instance_name=eq.<instance>
      const inst = eqValue(q.get("instance_name"));
      const email = inst ? this.seed.instanceEmail[inst] : undefined;
      return send(200, email ? [{ email }] : []);
    }

    if (table === "whatsapp_messages") {
      // isVendorThread: to_number=eq.<digits> & raw->>sender=eq.<email>
      const to = eqValue(q.get("to_number"));
      const sender = eqValue(q.get("raw->>sender")) ?? eqValue(q.get("raw-%3E%3Esender"));
      const hit = this.seed.vendorThreads.find(
        (t) => t.toNumber === to && (!sender || t.senderEmail === sender)
      );
      if (hit) {
        const iso = new Date(Date.now() - (hit.ageMs ?? 60_000)).toISOString();
        return send(200, [{ received_at: iso, raw: { sender: hit.senderEmail, kind: "rfq", rfq: { vehicleClass: "scooter" } } }]);
      }
      return send(200, []);
    }

    // Everything else: empty -> the engine uses its empty-DB defaults.
    return send(200, []);
  }
}

function eqValue(v: string | null): string | undefined {
  if (!v) return undefined;
  return v.startsWith("eq.") ? decodeURIComponent(v.slice(3)) : decodeURIComponent(v);
}

// ---------------------------------------------------------------------------
// Process spawners - boot the REAL gateway + workers as tsx child processes
// ---------------------------------------------------------------------------

export interface ServiceHandle {
  proc: ChildProcess;
  stop: () => Promise<void>;
}

// The sandbox sets an egress proxy whose lowercase no_proxy / GLOBAL_AGENT_NO_PROXY
// do NOT include 127.0.0.1, so a child's fetch to a localhost mock gets routed
// through the proxy (which can't reach it) and times out. The E2E children only
// ever talk to localhost (mock Evolution, mock Supabase, local Redis), so we
// strip every proxy var and force NO_PROXY so all their fetches go DIRECT.
const PROXY_KEYS = [
  "HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy",
  "ALL_PROXY", "all_proxy",
  "GLOBAL_AGENT_HTTP_PROXY", "GLOBAL_AGENT_HTTPS_PROXY",
];

function spawnService(entry: { tsconfig: string; script: string }, env: NodeJS.ProcessEnv, onLine?: (l: string) => void): ChildProcess {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env };
  for (const k of PROXY_KEYS) delete childEnv[k];
  childEnv.NO_PROXY = "*";
  childEnv.no_proxy = "*";
  childEnv.GLOBAL_AGENT_NO_PROXY = "*";
  const proc = spawn(
    "npx",
    ["tsx", "--tsconfig", entry.tsconfig, entry.script],
    { cwd: REPO_ROOT, env: childEnv, stdio: ["ignore", "pipe", "pipe"] }
  );
  const relay = (buf: Buffer) => {
    const s = buf.toString();
    if (process.env.MOCK_DEBUG) process.stderr.write(`[svc] ${s}`);
    if (onLine) for (const line of s.split("\n")) if (line.trim()) onLine(line);
  };
  proc.stdout?.on("data", relay);
  proc.stderr?.on("data", relay);
  return proc;
}

async function stopProc(proc: ChildProcess): Promise<void> {
  if (proc.exitCode != null || proc.signalCode != null) return;
  await new Promise<void>((r) => {
    proc.once("exit", () => r());
    proc.kill("SIGTERM");
    setTimeout(() => {
      if (proc.exitCode == null) proc.kill("SIGKILL");
      r();
    }, 6000).unref();
  });
}

/** Boot apps/gateway; resolves once GET /healthz returns 200. */
export async function startGateway(env: NodeJS.ProcessEnv & { GATEWAY_PORT: string }): Promise<ServiceHandle> {
  const proc = spawnService(
    { tsconfig: "apps/gateway/tsconfig.json", script: "apps/gateway/src/server.ts" },
    env
  );
  const base = `http://127.0.0.1:${env.GATEWAY_PORT}`;
  await waitFor(
    async () => {
      try {
        const r = await fetch(new URL("/healthz", base));
        return r.ok;
      } catch {
        return false;
      }
    },
    { timeoutMs: 30000, everyMs: 200 }
  );
  return { proc, stop: () => stopProc(proc) };
}

/** Boot services/workers; resolves once the scheduler's repeatable heartbeat is
 * registered in Redis - which main() does LAST, after every worker starts, so it
 * is a log-level-independent "all workers up" signal. A crash is surfaced early
 * via the child's stderr + a non-zero exit. */
export async function startWorkers(env: NodeJS.ProcessEnv & { REDIS_URL: string }): Promise<ServiceHandle> {
  let crashed: string | null = null;
  const proc = spawnService(
    { tsconfig: "services/workers/tsconfig.json", script: "services/workers/src/index.ts" },
    env,
    (line) => {
      if (/failed to start|Error:/i.test(line)) crashed = line;
    }
  );
  proc.once("exit", (code) => {
    if (code && code !== 0) crashed = crashed ?? `workers exited with code ${code}`;
  });
  const rc = await redisClient(env.REDIS_URL);
  try {
    await waitFor(
      async () => {
        if (crashed) throw new Error(`workers boot failed: ${crashed}`);
        const keys = await rc.keys("bull:scheduler_queue:*");
        return keys.length > 0;
      },
      { timeoutMs: 30000, everyMs: 200 }
    );
  } finally {
    await rc.quit().catch(() => {});
  }
  return { proc, stop: () => stopProc(proc) };
}

// ---------------------------------------------------------------------------
// Redis test helpers (lazy ioredis - only when a test actually needs them)
// ---------------------------------------------------------------------------

type MiniRedis = {
  flushdb(): Promise<unknown>;
  llen(k: string): Promise<number>;
  keys(pat: string): Promise<string[]>;
  quit(): Promise<unknown>;
};

export async function redisClient(url: string): Promise<MiniRedis> {
  const { default: Redis } = await import("ioredis");
  // retryStrategy null => never reconnect, so a missing server fails FAST (the
  // reachability probe must not hang the default `vitest run`).
  return new Redis(url, {
    maxRetriesPerRequest: 1,
    connectTimeout: 1500,
    retryStrategy: () => null,
    lazyConnect: false,
  }) as unknown as MiniRedis;
}

/** True if a Redis is reachable at `url` (used to self-skip the e2e suite). */
export async function redisReachable(url: string): Promise<boolean> {
  let c: MiniRedis | null = null;
  try {
    c = await redisClient(url);
    await (c as unknown as { ping(): Promise<string> }).ping();
    return true;
  } catch {
    return false;
  } finally {
    try {
      await c?.quit();
    } catch {
      /* ignore */
    }
  }
}
