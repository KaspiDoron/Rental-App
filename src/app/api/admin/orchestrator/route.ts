import { NextResponse } from "next/server";
import { requireManagement } from "@/lib/session";
import {
  getOrchestratorConfig,
  saveOrchestratorConfig,
  defaultOrchestratorConfig,
  type OrchestratorConfig,
} from "@/lib/orchestrator";
import { sbSelect } from "@/lib/runtime-config";

// The owner's window into the agent pipeline: read/edit the orchestrator
// config (stages, custom agents, edge rules, register + timing knobs) and
// stream the live per-decision traces. Config WRITES are owner-only, exactly
// like the old core-prompts editor this replaces.

interface TraceRow {
  id: number;
  decision_id: string;
  user_email: string | null;
  vendor_id: string | null;
  vendor_name: string | null;
  stage: string;
  input: string | null;
  reasoning: string | null;
  output: string | null;
  verdict: string | null;
  created_at: string;
}

export async function GET(req: Request) {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const url = new URL(req.url);
  const config = await getOrchestratorConfig();

  if (url.searchParams.get("traces") !== "1") {
    return NextResponse.json({ config, isOwner: session.role === "owner" });
  }

  const vendor = (url.searchParams.get("vendor") ?? "").trim();
  const user = (url.searchParams.get("user") ?? "").trim();
  let filter = "";
  if (vendor) filter += `&vendor_name=ilike.*${encodeURIComponent(vendor)}*`;
  if (user) filter += `&user_email=ilike.*${encodeURIComponent(user)}*`;
  const rows = await sbSelect<TraceRow>(
    "agent_traces",
    `select=id,decision_id,user_email,vendor_id,vendor_name,stage,input,reasoning,output,verdict,created_at&order=created_at.desc&limit=120${filter}`
  ).catch(() => [] as TraceRow[]);

  // Group stage rows into decisions, newest first.
  const byDecision = new Map<string, TraceRow[]>();
  for (const r of rows) {
    const list = byDecision.get(r.decision_id) ?? [];
    list.push(r);
    byDecision.set(r.decision_id, list);
  }
  const decisions = [...byDecision.entries()].map(([id, stages]) => ({
    decisionId: id,
    at: stages[stages.length - 1]?.created_at,
    userEmail: stages[0]?.user_email ?? null,
    vendorName: stages[0]?.vendor_name || stages[0]?.vendor_id || "unknown shop",
    stages: stages
      .slice()
      .sort((a, b) => a.id - b.id)
      .map((s) => ({
        stage: s.stage,
        input: s.input ?? "",
        reasoning: s.reasoning ?? "",
        output: s.output ?? "",
        verdict: s.verdict,
      })),
  }));

  return NextResponse.json({ config, decisions, isOwner: session.role === "owner" });
}

export async function POST(req: Request) {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (session.role !== "owner") {
    return NextResponse.json({ error: "Owner only" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  if (body.action === "reset") {
    const def = defaultOrchestratorConfig();
    await saveOrchestratorConfig(def);
    return NextResponse.json({ ok: true, config: def });
  }

  const cfg = body.config as OrchestratorConfig | undefined;
  if (!cfg || cfg.version !== 1 || !Array.isArray(cfg.stages)) {
    return NextResponse.json({ error: "Invalid config" }, { status: 400 });
  }
  // Sanitize: clamp knobs, cap list sizes and text lengths.
  const clean: OrchestratorConfig = {
    version: 1,
    thinkIterations: Math.min(Math.max(Number(cfg.thinkIterations) || 3, 3), 6),
    waitWindow: {
      minS: Math.min(Math.max(Number(cfg.waitWindow?.minS) || 120, 30), 1800),
      maxS: Math.min(Math.max(Number(cfg.waitWindow?.maxS) || 900, 60), 3600),
    },
    lowEnglish: Boolean(cfg.lowEnglish),
    streetLocal: Boolean(cfg.streetLocal),
    stages: cfg.stages.slice(0, 12).map((s, i) => ({
      id: String(s.id ?? `custom-${i}`).slice(0, 40),
      label: String(s.label ?? "Agent").slice(0, 80),
      enabled: Boolean(s.enabled),
      order: Number(s.order) || i + 1,
      instructions: String(s.instructions ?? "").slice(0, 1500),
      ...(s.custom ? { custom: true } : {}),
    })),
    rules: (Array.isArray(cfg.rules) ? cfg.rules : []).slice(0, 20).map((r, i) => ({
      id: String(r.id ?? `rule-${i}`).slice(0, 40),
      when: String(r.when ?? "").slice(0, 300),
      then: String(r.then ?? "").slice(0, 300),
      enabled: Boolean(r.enabled),
    })),
  };
  if (clean.waitWindow.maxS < clean.waitWindow.minS) {
    clean.waitWindow.maxS = clean.waitWindow.minS;
  }
  await saveOrchestratorConfig(clean);
  return NextResponse.json({ ok: true, config: clean });
}

// Vercel: allow slow upstreams (Hobby default is ~10s - too short).
export const maxDuration = 60;
