import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ROOT,
  Type,
  createExperimentRun,
  createPiExperimentSession,
  defineTool,
  finishRun,
  promptWithWatchdog,
  readJson,
  readText,
  safeRef,
  sha,
  writeJson,
  writeText,
} from "./lib.mjs";

const FIXTURE = readJson(path.join(ROOT, "fixtures", "e1-artifact-workspace.json"));
const { runDir, id } = createExperimentRun("e1-artifact-workspace", FIXTURE);
const taskDir = path.join(runDir, "work", "screenplay-ep-03");
const canonicalDir = path.join(runDir, "canonical");
const evidence = [];
let submitted = false;

for (const [ref, value] of Object.entries(FIXTURE.artifacts)) {
  writeText(path.join(runDir, ref), typeof value === "string" ? value : JSON.stringify(value, null, 2));
}
writeText(path.join(canonicalDir, "baseline.json"), JSON.stringify(FIXTURE.baseline, null, 2));

function artifactIndex() {
  const refs = ["canonical/ledger.json", "continuity/ep-02.json", "screenplay/ep-02.md"];
  return refs.map((ref) => ({ ref, digest: sha(readText(path.join(runDir, ref))), bytes: fs.statSync(path.join(runDir, ref)).size }));
}

const listArtifacts = defineTool({
  name: "list_artifacts", label: "List artifacts", description: "List readable canonical artifact references and digests.",
  parameters: Type.Object({}),
  async execute() { return { content: [{ type: "text", text: JSON.stringify(artifactIndex()) }], details: { refs: artifactIndex() } }; },
});
const searchArtifacts = defineTool({
  name: "search_artifacts", label: "Search artifacts", description: "Search canonical artifacts for a factual term before inventing story facts.",
  parameters: Type.Object({ query: Type.String({ minLength: 2 }) }),
  async execute(_id, params) {
    const hits = artifactIndex().flatMap(({ ref, digest }) => {
      const content = readText(path.join(runDir, ref));
      const tokens = params.query.toLowerCase().split(/[^a-z0-9-]+/).filter((token) => token.length >= 2);
      return tokens.some((token) => content.toLowerCase().includes(token)) ? [{ ref, digest, excerpt: content.slice(0, 900) }] : [];
    });
    evidence.push({ kind: "search", query: params.query, hits: hits.map((hit) => ({ ref: hit.ref, digest: hit.digest })) });
    return { content: [{ type: "text", text: JSON.stringify(hits) }], details: { hits } };
  },
});
const readArtifact = defineTool({
  name: "read_artifact", label: "Read artifact", description: "Read a canonical artifact by its exact ref. This is read-only and recorded as evidence.",
  parameters: Type.Object({ ref: Type.String() }),
  async execute(_id, params) {
    const file = safeRef(runDir, params.ref, ["canonical", "continuity", "screenplay"]);
    const content = readText(file);
    evidence.push({ kind: "read", ref: params.ref, digest: sha(content) });
    return { content: [{ type: "text", text: content }], details: { ref: params.ref, digest: sha(content) } };
  },
});
const writeDraft = defineTool({
  name: "write_draft", label: "Write draft", description: "Write the current task's mutable screenplay draft only inside the sandbox.",
  parameters: Type.Object({ markdown: Type.String({ minLength: 100 }) }),
  async execute(_id, params) {
    writeText(path.join(taskDir, "draft.md"), params.markdown);
    return { content: [{ type: "text", text: "draft saved" }], details: { digest: sha(params.markdown) } };
  },
});
const runChecks = defineTool({
  name: "run_checks", label: "Run checks", description: "Check the sandbox screenplay draft against the required maker-mark ownership and required ending.",
  parameters: Type.Object({}),
  async execute() {
    const draft = fs.existsSync(path.join(taskDir, "draft.md")) ? readText(path.join(taskDir, "draft.md")) : "";
    const errors = [];
    if (!draft.includes("Master Gu") && !draft.includes("顾师傅")) errors.push("draft does not show Master Gu holding or revealing the authentic fragment");
    if (/Lin Qiao[^\n]{0,100}(holds|holding|持有)[^\n]{0,100}LQ-17/i.test(draft)) errors.push("Lin Qiao cannot already hold the authentic LQ-17 fragment before Master Gu reveals it");
    if (!draft.includes("LQ-17")) errors.push("draft lacks LQ-17 maker mark");
    if (!/(inner petal|内瓣|花瓣).*?(open|打开|展开)/is.test(draft)) errors.push("draft lacks the opened inner petal ending");
    writeJson(path.join(taskDir, "check-report.json"), { errors, draftDigest: sha(draft) });
    return { content: [{ type: "text", text: errors.length ? `FAIL: ${errors.join("; ")}` : "PASS" }], details: { errors } };
  },
});
const submitScreenplay = defineTool({
  name: "submit_screenplay", label: "Submit screenplay", description: "Promote the validated sandbox draft to canonical screenplay ep03 and record evidence.",
  parameters: Type.Object({}),
  async execute() {
    const draft = readText(path.join(taskDir, "draft.md"));
    const report = readJson(path.join(taskDir, "check-report.json"));
    if (report.errors.length) return { content: [{ type: "text", text: `REJECTED: ${report.errors.join("; ")}` }], details: report, terminate: false };
    if (!evidence.some((item) => item.kind === "read" && item.ref === "continuity/ep-02.json")) {
      return { content: [{ type: "text", text: "REJECTED: read continuity/ep-02.json before submission" }], details: {}, terminate: false };
    }
    writeText(path.join(runDir, "screenplay", "ep-03.md"), draft);
    writeJson(path.join(runDir, "tasks", "screenplay-ep-03.evidence.json"), evidence);
    submitted = true;
    return { content: [{ type: "text", text: "ACCEPTED screenplay ep03" }], details: { evidence }, terminate: true };
  },
});

const systemPrompt = `You are a screenplay writer running an artifact-exploration experiment. Your baseline context is intentionally incomplete. Before drafting, decide what fact is missing and inspect canonical artifacts with search_artifacts/read_artifact. You must work iteratively in the sandbox: write_draft, run_checks, correct if needed, then submit_screenplay. Never invent ownership of the authentic LQ-17 shard. Do not explain the process in prose; use tools.`;
const { session, metrics } = await createPiExperimentSession({
  runDir,
  role: "e1-writer",
  systemPrompt,
  customTools: [listArtifacts, searchArtifacts, readArtifact, writeDraft, runChecks, submitScreenplay],
  toolNames: ["list_artifacts", "search_artifacts", "read_artifact", "write_draft", "run_checks", "submit_screenplay"],
});

try {
  await promptWithWatchdog(session, metrics, `Write episode 3. Baseline context:\n${JSON.stringify(FIXTURE.baseline)}\n\nThe episode must end with the opened inner petal in Lin Qiao's hand.`);
  if (!submitted) throw new Error("agent ended without a canonical submission");
  const finalDraft = readText(path.join(runDir, "screenplay", "ep-03.md"));
  if (!evidence.some((item) => item.kind === "search" && item.hits.length)) throw new Error("artifact search did not produce a measurable hit");
  finishRun(runDir, { outcome: "passed", metrics, finalDigest: sha(finalDraft), evidence });
  console.log(JSON.stringify({ id, runDir, outcome: "passed", metrics, evidence }, null, 2));
} catch (error) {
  finishRun(runDir, { outcome: "failed", metrics, error: String(error?.message || error), evidence });
  throw error;
} finally {
  session.dispose();
}
