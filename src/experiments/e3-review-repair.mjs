import fs from "node:fs";
import path from "node:path";
import { ROOT, Type, createExperimentRun, createPiExperimentSession, defineTool, finishRun, promptWithWatchdog, readJson, readText, sha, writeJson, writeText } from "./lib.mjs";

const fixture = readJson(path.join(ROOT, "fixtures", "e3-review-repair.json"));
const { id, runDir } = createExperimentRun("e3-review-repair", fixture);
for (const [name, content] of Object.entries(fixture.episodes)) writeText(path.join(runDir, "screenplay", name), content);
writeJson(path.join(runDir, "canonical", "ledger.json"), fixture.ledger);
writeText(path.join(runDir, "storyboard", "ep-03.md"), "placeholder storyboard dependent on the old ep03");
writeJson(path.join(runDir, "tasks", "screenplay-ep-04.json"), { id: "screenplay-ep-04", state: "passed", dependsOn: "screenplay-ep-03" });

let windowReview = null;
let repairPlan = null;
let repaired = false;

async function runWindowReviewer() {
  const submitReview = defineTool({
    name: "submit_review", label: "Submit window review", description: "Submit a structured review of episodes 2-3. Cite exact contradictory facts and recommend a repair scope.",
    parameters: Type.Object({ severity: Type.Union([Type.Literal("P0"), Type.Literal("P1"), Type.Literal("P2")]), episode: Type.Integer(), evidence: Type.String({ minLength: 40 }), recommendedScope: Type.String({ minLength: 3 }), summary: Type.String({ minLength: 40 }) }),
    async execute(_id, params) {
      if (params.episode !== 3 || !/LQ-17|fragment|碎片/i.test(params.evidence)) return { content: [{ type: "text", text: "REJECTED: cite the ep02/ep03 LQ-17 ownership contradiction at episode 3" }], details: {}, terminate: false };
      windowReview = params;
      writeJson(path.join(runDir, "reviews", "window-02-03.json"), params);
      return { content: [{ type: "text", text: "ACCEPTED window review" }], details: params, terminate: true };
    },
  });
  const { session, metrics } = await createPiExperimentSession({ runDir, role: "e3-window-reviewer", systemPrompt: "You are a fresh Window Reviewer. Compare ep02 and ep03 against the ledger. Do not repair. Find the concrete continuity contradiction and submit one review finding with the smallest plausible repair scope.", customTools: [submitReview], toolNames: ["submit_review"] });
  try {
    await promptWithWatchdog(session, metrics, `Ledger: ${JSON.stringify(fixture.ledger)}\n\nEP02:\n${fixture.episodes["ep-02.md"]}\n\nEP03:\n${fixture.episodes["ep-03.md"]}`);
  } finally { session.dispose(); }
  if (!windowReview) throw new Error("window reviewer did not submit a review");
  return metrics;
}

async function runSeriesReviewer() {
  const submitRepairPlan = defineTool({
    name: "submit_repair_plan", label: "Submit repair plan", description: "Submit the final repair plan. The plan must distinguish a local episode repair from an upstream rewrite.",
    parameters: Type.Object({ targetEpisodes: Type.Array(Type.Integer(), { minItems: 1, maxItems: 2 }), upstreamRequired: Type.Boolean(), instruction: Type.String({ minLength: 60 }), preserve: Type.Array(Type.String(), { minItems: 1 }) }),
    async execute(_id, params) {
      if (params.upstreamRequired || params.targetEpisodes.length !== 1 || params.targetEpisodes[0] !== 3) return { content: [{ type: "text", text: "REJECTED: this fixture is a local ep03 continuity repair, not an upstream rewrite" }], details: {}, terminate: false };
      repairPlan = params;
      writeJson(path.join(runDir, "reviews", "repair-plan.json"), params);
      return { content: [{ type: "text", text: "ACCEPTED repair plan" }], details: params, terminate: true };
    },
  });
  const { session, metrics } = await createPiExperimentSession({ runDir, role: "e3-series-reviewer", systemPrompt: "You are the final all-series Reviewer. Window reviewers only propose; you decide the smallest repair plan. Preserve later episode intent and never use an upstream rewrite for a local ownership contradiction.", customTools: [submitRepairPlan], toolNames: ["submit_repair_plan"] });
  try {
    await promptWithWatchdog(session, metrics, `Ledger: ${JSON.stringify(fixture.ledger)}\nWindow review: ${JSON.stringify(windowReview)}\nEP02: ${fixture.episodes["ep-02.md"]}\nEP03: ${fixture.episodes["ep-03.md"]}\nEP04: ${fixture.episodes["ep-04.md"]}`);
  } finally { session.dispose(); }
  if (!repairPlan) throw new Error("series reviewer did not submit repair plan");
  return metrics;
}

async function runRepairWriter() {
  const taskDir = path.join(runDir, "work", "repair-ep-03");
  const writeDraft = defineTool({ name: "write_draft", label: "Write repair draft", description: "Write only the ep03 repair draft in the task sandbox.", parameters: Type.Object({ markdown: Type.String({ minLength: 80 }) }), async execute(_id, params) { writeText(path.join(taskDir, "draft.md"), params.markdown); return { content: [{ type: "text", text: "draft saved" }], details: {} }; } });
  const runChecks = defineTool({ name: "run_checks", label: "Check repair", description: "Verify the repair preserves Master Gu as owner of authentic LQ-17 and Lin receives it on-screen.", parameters: Type.Object({}), async execute() { const draft = readText(path.join(taskDir, "draft.md")); const errors = []; if (!/Master Gu|顾师傅/.test(draft)) errors.push("Master Gu must reveal the authentic shard"); if (/carried since|一直带着|一直携带/.test(draft)) errors.push("Lin cannot have carried the authentic shard from ep02"); if (!/hands?|递给|交给|handed/i.test(draft)) errors.push("draft must show Master Gu handing the shard to Lin"); writeJson(path.join(taskDir, "check-report.json"), { errors }); return { content: [{ type: "text", text: errors.length ? `FAIL: ${errors.join("; ")}` : "PASS" }], details: { errors } }; } });
  const submitRepair = defineTool({ name: "submit_screenplay", label: "Submit repaired ep03", description: "Promote the checked ep03 repair and mark dependent artifacts stale.", parameters: Type.Object({}), async execute() { const report = readJson(path.join(taskDir, "check-report.json")); if (report.errors.length) return { content: [{ type: "text", text: `REJECTED: ${report.errors.join("; ")}` }], details: report, terminate: false }; const draft = readText(path.join(taskDir, "draft.md")); writeText(path.join(runDir, "screenplay", "ep-03.md"), draft); writeJson(path.join(runDir, "tasks", "storyboard-ep-03.json"), { id: "storyboard-ep-03", state: "stale", reason: "screenplay ep03 revised" }); writeJson(path.join(runDir, "tasks", "screenplay-ep-04.json"), { id: "screenplay-ep-04", state: "stale", reason: "depends on revised ep03 continuity" }); repaired = true; return { content: [{ type: "text", text: "ACCEPTED repaired ep03 and marked dependent tasks stale" }], details: {}, terminate: true }; } });
  const { session, metrics } = await createPiExperimentSession({ runDir, role: "e3-repair-writer", systemPrompt: "You are a scoped Repair Writer. Use the approved Repair Plan only. Work in scratch: write_draft, run_checks, then submit_screenplay. Do not alter ep02 or ep04.", customTools: [writeDraft, runChecks, submitRepair], toolNames: ["write_draft", "run_checks", "submit_screenplay"] });
  try { await promptWithWatchdog(session, metrics, `Repair plan: ${JSON.stringify(repairPlan)}\nLedger: ${JSON.stringify(fixture.ledger)}\nEP02: ${fixture.episodes["ep-02.md"]}\nBroken EP03: ${fixture.episodes["ep-03.md"]}\nEP04 constraint: ${fixture.episodes["ep-04.md"]}`); } finally { session.dispose(); }
  if (!repaired) throw new Error("repair writer did not submit repaired ep03");
  return metrics;
}

try {
  const windowMetrics = await runWindowReviewer();
  const seriesMetrics = await runSeriesReviewer();
  const repairMetrics = await runRepairWriter();
  const staleBoard = readJson(path.join(runDir, "tasks", "storyboard-ep-03.json")).state;
  const staleNext = readJson(path.join(runDir, "tasks", "screenplay-ep-04.json")).state;
  if (staleBoard !== "stale" || staleNext !== "stale") throw new Error("stale propagation failed");
  finishRun(runDir, { outcome: "passed", metrics: { windowMetrics, seriesMetrics, repairMetrics }, repairPlan, staleBoard, staleNext });
  console.log(JSON.stringify({ id, runDir, outcome: "passed", windowReview, repairPlan, staleBoard, staleNext }, null, 2));
} catch (error) {
  finishRun(runDir, { outcome: "failed", error: String(error?.message || error) });
  throw error;
}
