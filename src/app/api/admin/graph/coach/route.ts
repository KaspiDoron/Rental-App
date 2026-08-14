import { NextResponse } from "next/server";
import { requireManagement } from "@/lib/session";
import { chat, extractJson } from "@/lib/ai";
import { getGraphSpec } from "@/lib/graph/engine";
import { saveVersionedSpec } from "@/lib/policy";
import { sbInsert, sbSelect } from "@/lib/runtime-config";
import type { GraphSpec } from "@/lib/graph/types";

// The Coach: the owner writes a plain-text verdict ("too pushy", "always use
// the days as leverage", "never accept near double the floor") plus an
// optional 1-5 score, and the pipeline UPDATES ITSELF - an agent turns the
// feedback into concrete instruction patches on the right nodes of the live
// graph spec, applies them, and reports exactly what changed. Every lesson is
// also stored durably so the bargaining agent learns from it as an example.

interface CoachPatch {
  nodeId: string;
  nodeLabel: string;
  appended: string;
}

const MAX_PATCHES = 4;
const MAX_APPEND = 400;

function deterministicPatch(spec: GraphSpec, feedback: string): CoachPatch[] {
  // No AI available: the feedback still lands, verbatim, on the Director (the
  // chief reads it on every decision) - never silently dropped.
  const director = spec.nodes.find((n) => n.id === "director");
  if (!director) return [];
  const line = `OWNER FEEDBACK: ${feedback.slice(0, MAX_APPEND)}`;
  director.instructions = [director.instructions, line].filter(Boolean).join("\n");
  return [{ nodeId: "director", nodeLabel: director.label, appended: line }];
}

export async function GET() {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const rows = await sbSelect<{ text: string; created_at?: string }>(
    "agent_training",
    "select=text,created_at&order=created_at.desc&limit=15"
  );
  return NextResponse.json({
    log: rows
      .filter((r) => (r.text ?? "").startsWith("[COACH"))
      .map((r) => ({ text: r.text, at: r.created_at })),
  });
}

export async function POST(req: Request) {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  const feedback = String(body.feedback ?? "").trim().slice(0, 2000);
  if (!feedback) {
    return NextResponse.json({ error: "Write what was good / bad first." }, { status: 400 });
  }
  const score =
    Number.isFinite(Number(body.score)) && Number(body.score) >= 1 && Number(body.score) <= 5
      ? Math.round(Number(body.score))
      : undefined;
  const context = String(body.context ?? "").slice(0, 4000);

  const spec = await getGraphSpec();
  const nodeCatalog = spec.nodes
    .map(
      (n) =>
        `- ${n.id} ("${n.label}"): ${
          (n.instructions ?? "").slice(0, 160) || "(no instructions yet)"
        }`
    )
    .join("\n");

  let patches: CoachPatch[] = [];
  let summary = "";
  let fromAi = false;

  const out = await chat(
    [
      {
        role: "system",
        content:
          "You are the pipeline Coach for a WhatsApp rental-negotiation agent system. The owner " +
          "gives feedback on how the agents behaved; you convert it into SHORT, imperative " +
          "instruction additions on the RIGHT nodes of the pipeline. Rules: touch at most " +
          `${MAX_PATCHES} nodes, each addition one or two sentences (max ${MAX_APPEND} chars), ` +
          "concrete and testable ('ask the floor price first, using the rental days as leverage'), " +
          "never delete or rewrite existing instructions, never invent node ids. " +
          'Reply ONLY as JSON: { "patches": [ { "nodeId": string, "append": string } ], ' +
          '"summary": "one sentence describing the lesson applied" }.',
      },
      {
        role: "user",
        content:
          `PIPELINE NODES (id, label, current instructions excerpt):\n${nodeCatalog}\n\n` +
          (context ? `THE RUN BEING SCORED:\n${context}\n\n` : "") +
          `OWNER FEEDBACK${score ? ` (score ${score}/5)` : ""}:\n${feedback}`,
      },
    ],
    { maxTokens: 500 }
  );
  if (out) {
    const parsed = extractJson<{ patches?: { nodeId?: string; append?: string }[]; summary?: string }>(out);
    if (parsed?.patches?.length) {
      for (const p of parsed.patches.slice(0, MAX_PATCHES)) {
        const node = spec.nodes.find((n) => n.id === String(p.nodeId ?? ""));
        const append = String(p.append ?? "").trim().slice(0, MAX_APPEND);
        if (!node || !append) continue;
        node.instructions = [node.instructions, append].filter(Boolean).join("\n");
        patches.push({ nodeId: node.id, nodeLabel: node.label, appended: append });
      }
      summary = String(parsed.summary ?? "").slice(0, 300);
      fromAi = patches.length > 0;
    }
  }
  if (patches.length === 0) {
    patches = deterministicPatch(spec, feedback);
    summary = "No AI coach available - the feedback was pinned verbatim onto the Director so it still guides every decision.";
  }
  if (patches.length === 0) {
    return NextResponse.json({ error: "Could not apply the feedback to any node." }, { status: 500 });
  }

  // EVAL GATE (Wave 3): the Coach used to be the ONE spec-writing path with no
  // golden replay in front of it - an LLM rewriting live node instructions
  // shipped ungated while the owner's hand edit next door was gated. Same gate,
  // same fail-closed rule as every other behavior change.
  const { runGoldenSuite, goldenGateBlocks } = await import("@/lib/ops/golden");
  const { sanitizeGraphSpec } = await import("@/lib/graph/default-graph");
  const candidate = sanitizeGraphSpec(spec);
  const report = await runGoldenSuite({ spec: candidate });
  const blocked = goldenGateBlocks(report);
  if (blocked) {
    return NextResponse.json(
      { error: `${blocked} The coach patch was NOT applied.`, report },
      { status: 409 }
    );
  }

  const saved = await saveVersionedSpec({
    kind: "graph_spec",
    spec: candidate,
    note: `Coach: ${(summary || feedback).slice(0, 200)}`,
    author: session.email,
    replayReport: report,
  });
  if (!saved.ok) {
    return NextResponse.json(
      { error: `The updated pipeline failed validation: ${saved.problems.join("; ")}` },
      { status: 500 }
    );
  }

  // Durable lesson log - ALSO read as a live training example by the
  // bargaining composer, so the tone lesson reaches the messages themselves.
  sbInsert("agent_training", [
    {
      text: `[COACH ${new Date().toISOString().slice(0, 10)}${score ? ` ${score}/5` : ""}] ${feedback.slice(0, 800)}`,
    },
  ]).catch(() => {});

  return NextResponse.json({ applied: true, fromAi, summary, patches });
}

export const maxDuration = 60;
