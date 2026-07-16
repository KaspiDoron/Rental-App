// Policy versioning - the single chokepoint for every behavior-affecting
// write (graph spec edits, coach patches, ops rules, threshold overlays).
//
// Every save lands as a full snapshot in policy_versions (audit trail), the
// newest activated row's id becomes the "active behavior revision" stamped on
// all traces/scores (see ops/rev.ts), and rollback is just re-activating an
// older row. From Phase 4 on, activation of behavior changes is gated on a
// passing golden-replay report.
//
// Demo mode (no Supabase): the underlying setConfig/sb* helpers no-op softly,
// so saves still apply in-process and versioning silently degrades.

import "server-only";
import { sbSelect, sbInsertReturning, sbUpdate, setConfig } from "./runtime-config";
import { saveGraphSpec } from "./graph/engine";
import { sanitizeGraphSpec } from "./graph/default-graph";
import type { GraphSpec } from "./graph/types";
import { bustActiveRevCache } from "./ops/rev";
import { clampOverlay, bustOverlayCache } from "./ops/overlay";
import type { PolicyKind, PolicyVersion, ReplayReport } from "./ops/types";

// The overlay itself lives in ops/overlay.ts (a leaf the engine can import
// without cycles); re-export so callers keep one policy entry point.
export {
  clampOverlay,
  getPolicyOverlay,
  bustOverlayCache,
  DEFAULT_OVERLAY,
  type PolicyOverlay,
} from "./ops/overlay";

// ---------------------------------------------------------------------------
// Versioned saves
// ---------------------------------------------------------------------------

export interface VersionedSaveResult {
  ok: boolean;
  problems: string[];
  versionId: number | null;
}

/**
 * Persist a behavior change AND record it as a policy_versions row in one
 * step. graph_spec goes through the engine's sanitize+validate (a bad spec
 * never lands); policy_overlay is hard-clamped. The new row becomes active.
 */
export async function saveVersionedSpec(args: {
  kind: PolicyKind;
  spec: unknown;
  note: string;
  author: string;
  replayReport?: ReplayReport | null;
}): Promise<VersionedSaveResult> {
  if (args.kind === "graph_spec") {
    const clean = sanitizeGraphSpec(args.spec as GraphSpec);
    const res = await saveGraphSpec(clean);
    if (!res.ok) return { ...res, versionId: null };
    const versionId = await recordVersion(args.kind, clean, args.note, args.author, args.replayReport);
    return { ok: true, problems: [], versionId };
  }
  // policy_overlay
  const clean = clampOverlay(args.spec);
  await setConfig("policy_overlay", JSON.stringify(clean)).catch(() => {});
  bustOverlayCache();
  const versionId = await recordVersion(args.kind, clean, args.note, args.author, args.replayReport);
  return { ok: true, problems: [], versionId };
}

/** Roll back / re-activate an existing version row (no new row is created). */
export async function activateVersion(
  id: number,
  replayReport?: ReplayReport | null
): Promise<{ ok: boolean; problems: string[] }> {
  const rows = await sbSelect<PolicyVersion>(
    "policy_versions",
    `select=id,kind,version,spec&id=eq.${Math.round(id)}&limit=1`
  ).catch(() => []);
  const row = rows[0];
  if (!row) return { ok: false, problems: ["Version not found."] };

  if (row.kind === "graph_spec") {
    const res = await saveGraphSpec(sanitizeGraphSpec(row.spec as GraphSpec));
    if (!res.ok) return res;
  } else {
    await setConfig("policy_overlay", JSON.stringify(clampOverlay(row.spec))).catch(() => {});
    bustOverlayCache();
  }
  await sbUpdate("policy_versions", `kind=eq.${row.kind}&active=is.true`, { active: false }).catch(
    () => false
  );
  const patch: Record<string, unknown> = { active: true };
  if (replayReport) patch.replay_score = replayReport;
  await sbUpdate("policy_versions", `id=eq.${row.id}`, patch).catch(() => false);
  await setConfig("ops_active_rev", String(row.id)).catch(() => {});
  bustActiveRevCache();
  return { ok: true, problems: [] };
}

/** Version history for the Policy tab (newest first). */
export async function listVersions(kind?: PolicyKind, limit = 30): Promise<PolicyVersion[]> {
  const filter = kind ? `kind=eq.${kind}&` : "";
  return sbSelect<PolicyVersion>(
    "policy_versions",
    `select=id,kind,version,note,author,replay_score,active,created_at&${filter}order=created_at.desc&limit=${Math.min(
      100,
      Math.max(1, limit)
    )}`
  ).catch(() => []);
}

async function recordVersion(
  kind: PolicyKind,
  spec: unknown,
  note: string,
  author: string,
  replay?: ReplayReport | null
): Promise<number | null> {
  try {
    const prev = await sbSelect<{ version: number }>(
      "policy_versions",
      `select=version&kind=eq.${kind}&order=version.desc&limit=1`
    ).catch(() => []);
    const version = (prev[0]?.version ?? 0) + 1;
    await sbUpdate("policy_versions", `kind=eq.${kind}&active=is.true`, { active: false }).catch(
      () => false
    );
    const rows = await sbInsertReturning<{ id: number }>("policy_versions", [
      {
        kind,
        version,
        spec,
        note: note.slice(0, 500),
        author: author.slice(0, 200),
        replay_score: replay ?? null,
        active: true,
      },
    ]).catch(() => []);
    const id = rows[0]?.id ?? null;
    if (id) {
      await setConfig("ops_active_rev", String(id)).catch(() => {});
      bustActiveRevCache();
    }
    return id;
  } catch {
    return null; // versioning must never block the save itself
  }
}
