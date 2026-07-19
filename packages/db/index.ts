// @wheeldeal/db - the data-access layer for the GCP services.
//
// OWNER MANDATE: the database stays on SUPABASE (100% free fixed cost, zero
// VM memory). Two access styles, one package:
//   1. sql()/withPgClient - a tiny `pg` Pool through Supabase's Supavisor
//      connection pooler (TRANSACTION mode, port 6543). Real transactions +
//      INSERT ... ON CONFLICT idempotency for the workers. Pool max stays
//      small (default 5/process) so N processes never exhaust the free-tier
//      client cap. NOTE: transaction mode = no LISTEN/NOTIFY, no prepared
//      statement reuse across clients - Redis pub/sub owns realtime instead.
//   2. The PostgREST adapter (sbSelect/sbInsert/...) re-exported from the
//      existing runtime-config, so every already-ported core module keeps
//      working before its call sites are rewritten to SQL.

import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { logger } from "../shared";

let pool: Pool | null = null;

/**
 * Lazy pooled connection to Supabase via Supavisor (transaction mode).
 * Env: SUPABASE_DB_URL = postgres://...@<project>.pooler.supabase.com:6543/postgres
 */
export function pgPool(): Pool {
  if (!pool) {
    const url = process.env.SUPABASE_DB_URL;
    if (!url) {
      throw new Error(
        "SUPABASE_DB_URL is not set (Supavisor pooled connection string, port 6543)"
      );
    }
    pool = new Pool({
      connectionString: url,
      max: Number(process.env.PG_POOL_MAX || 5),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      // Supabase requires TLS; the pooler presents a valid cert chain.
      ssl: { rejectUnauthorized: false },
    });
    pool.on("error", (e) => logger.error({ err: e.message }, "pg pool error"));
  }
  return pool;
}

/** One-shot parameterized query. */
export async function sql<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = []
): Promise<T[]> {
  const res = await pgPool().query<T>(text, params);
  return res.rows;
}

/** Run a function inside a transaction (commit on return, rollback on throw). */
export async function withPgClient<T>(
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pgPool().connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// PostgREST adapter (incremental-port backend) - the exact functions the
// current codebase uses, unchanged.
export {
  sbSelect,
  sbInsert,
  sbUpdate,
  getConfig,
  setConfig,
} from "../../src/lib/runtime-config";
