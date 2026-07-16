import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/session";
import { getGraphSpec } from "@/lib/graph/engine";
import { sanitizeGraphSpec } from "@/lib/graph/default-graph";
import { getPolicyOverlay, clampOverlay } from "@/lib/ops/overlay";
import { listGoldenCases, runGoldenCase } from "@/lib/ops/golden";
import type { GraphSpec } from "@/lib/graph/types";
import type { ReplayCaseResult, ReplayReport } from "@/lib/ops/types";

// Champion/challenger over the golden suite: replay every enabled case under
// the LIVE baseline and (optionally) a candidate spec/overlay, deterministically
// (no LLM calls - the whole suite fits one request). This powers the Policy
// tab's diff view; the activation gate itself runs server-side in ops/policy.

export async function POST(req: Request) {
  const session = await requireOwner();
  if (!session) return NextResponse.json({ error: "Owner only." }, { status: 403 });
  const body = await req.json().catch(() => ({}));

  const all = await listGoldenCases(true);
  const wanted: number[] | null = Array.isArray(body.caseIds)
    ? body.caseIds.map(Number).filter(Number.isFinite)
    : null;
  const cases = wanted ? all.filter((c) => wanted.includes(c.id)) : all;

  const liveSpec = await getGraphSpec();
  const liveOverlay = await getPolicyOverlay();

  let candSpec: GraphSpec | undefined;
  let candOverlay: ReturnType<typeof clampOverlay> | undefined;
  if (body.candidate?.kind === "graph_spec" && body.candidate.spec) {
    candSpec = sanitizeGraphSpec(body.candidate.spec as GraphSpec);
  } else if (body.candidate?.kind === "policy_overlay" && body.candidate.spec) {
    candOverlay = clampOverlay(body.candidate.spec);
  }

  const baselineResults: ReplayCaseResult[] = [];
  const candidateResults: ReplayCaseResult[] = [];
  for (const gc of cases) {
    baselineResults.push(await runGoldenCase(gc, { spec: liveSpec, overlay: liveOverlay }));
    if (candSpec || candOverlay) {
      candidateResults.push(
        await runGoldenCase(gc, {
          spec: candSpec ?? liveSpec,
          overlay: candOverlay ?? liveOverlay,
        })
      );
    }
  }
  const report = (results: ReplayCaseResult[]): ReplayReport => ({
    ranAt: new Date().toISOString(),
    total: results.length,
    passed: results.filter((r) => r.pass).length,
    cases: results,
  });

  return NextResponse.json({
    baseline: report(baselineResults),
    candidate: candSpec || candOverlay ? report(candidateResults) : null,
  });
}

export const maxDuration = 60;
