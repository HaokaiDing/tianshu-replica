import fs from "node:fs";
import path from "node:path";
import { EXPERIMENT_ROOT, Type, createExperimentRun, createPiExperimentSession, defineTool, finishRun, promptWithWatchdog, readJson, readText, writeJson } from "./lib.mjs";

function latest(prefix) {
  const candidates = fs.readdirSync(EXPERIMENT_ROOT).filter((name) => name.startsWith(prefix)).sort();
  if (!candidates.length) throw new Error(`missing prerequisite experiment: ${prefix}`);
  return path.join(EXPERIMENT_ROOT, candidates.at(-1));
}

const sources = {
  e1: latest("e1-artifact-workspace-"),
  e2: latest("e2-research-planner-"),
  e3: latest("e3-review-repair-"),
  e4: latest("e4-storyboard-"),
};
const { id, runDir } = createExperimentRun("e5-acceptance", sources);
let verdict = null;
const requiredReads = new Set([
  "e1:tasks/screenplay-ep-03.evidence.json",
  "e2:research/art-nouveau.json",
  "e2:canonical/planning-bundle.json",
  "e3:reviews/window-02-03.json",
  "e3:reviews/repair-plan.json",
  "e4:storyboard/ep-01.md",
]);
const observedReads = new Set();
const readExperiment = defineTool({
  name: "read_experiment_artifact", label: "Read experiment artifact", description: "Read a named artifact from E1, E2, E3, or E4. Use it to assess the actual evidence, not assumptions.",
  parameters: Type.Object({ experiment: Type.Union([Type.Literal("e1"), Type.Literal("e2"), Type.Literal("e3"), Type.Literal("e4")]), relativePath: Type.String() }),
  async execute(_id, params) {
    const root = sources[params.experiment];
    const file = path.resolve(root, params.relativePath);
    if (!file.startsWith(`${root}${path.sep}`) || !fs.existsSync(file)) return { content: [{ type: "text", text: "REJECTED: artifact does not exist or is outside experiment root" }], details: {}, terminate: false };
    observedReads.add(`${params.experiment}:${params.relativePath}`);
    return { content: [{ type: "text", text: readText(file).slice(0, 16000) }], details: { file } };
  },
});
const submitAcceptance = defineTool({
  name: "submit_acceptance", label: "Submit acceptance", description: "Submit a final architecture-experiment verdict with evidence-backed blockers or follow-ups.",
  parameters: Type.Object({ verdict: Type.Union([Type.Literal("accept"), Type.Literal("accept_with_followups"), Type.Literal("reject")]), blockers: Type.Array(Type.String()), followups: Type.Array(Type.String()), summary: Type.String({ minLength: 80 }) }),
  async execute(_id, params) {
    const missing = [...requiredReads].filter((ref) => !observedReads.has(ref));
    if (missing.length) return { content: [{ type: "text", text: `REJECTED: read required evidence first: ${missing.join(", ")}` }], details: { missing }, terminate: false };
    verdict = params;
    writeJson(path.join(runDir, "acceptance.json"), params);
    return { content: [{ type: "text", text: "ACCEPTED final verdict" }], details: params, terminate: true };
  },
});
const { session, metrics } = await createPiExperimentSession({
  runDir,
  role: "e5-acceptance-reviewer",
  systemPrompt: "You are a fresh architecture acceptance reviewer. Read actual artifacts from each experiment before deciding. Verify E1 artifact exploration/scratch evidence, E2 sourced research policy, E3 repair/stale propagation, and E4 fixed-11-column storyboard plus native DOCX evidence. Do not invent blockers. Submit accept_with_followups if the architecture is viable but any production hardening remains.",
  customTools: [readExperiment, submitAcceptance],
  toolNames: ["read_experiment_artifact", "submit_acceptance"],
});
try {
  await promptWithWatchdog(session, metrics, `Experiment roots: ${JSON.stringify(sources)}. Read evidence before rendering your verdict.`);
  if (!verdict) throw new Error("acceptance reviewer did not submit verdict");
  finishRun(runDir, { outcome: "passed", metrics, verdict, sources });
  console.log(JSON.stringify({ id, runDir, outcome: "passed", verdict, sources }, null, 2));
} catch (error) {
  finishRun(runDir, { outcome: "failed", metrics, error: String(error?.message || error), sources });
  throw error;
} finally { session.dispose(); }
