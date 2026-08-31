import fs from "node:fs";
import path from "node:path";
import { Type, createPiExperimentSession, defineTool, promptWithWatchdog } from "./experiments/lib.mjs";
import { readJson, readText, sha, writeJson, writeText } from "./core.mjs";

const ep = (episode) => String(episode).padStart(2, "0");

function currentPath(runDir) {
  return path.join(runDir, "continuity", "current.json");
}

function episodePath(runDir, episode) {
  return path.join(runDir, "continuity", `ep-${ep(episode)}.json`);
}

function eventDir(runDir, episode) {
  return path.join(runDir, "continuity", "events", `ep-${ep(episode)}`);
}

function contractText(runDir) {
  const explicit = path.join(runDir, "canonical", "continuity-contract.md");
  if (fs.existsSync(explicit)) return readText(explicit);
  const fallback = ["characters.md", "design.md", "ledger.json"]
    .map((name) => path.join(runDir, "canonical", name))
    .filter((file) => fs.existsSync(file))
    .map((file) => `## ${path.basename(file)}\n${readText(file)}`)
    .join("\n\n");
  if (!fallback) throw new Error("continuity baseline is unavailable");
  return fallback;
}

function usageTotal(metrics) {
  return metrics.usage.reduce((sum, item) => ({
    input: sum.input + (item.input || 0),
    output: sum.output + (item.output || 0),
    cacheRead: sum.cacheRead + (item.cacheRead || 0),
    cacheWrite: sum.cacheWrite + (item.cacheWrite || 0),
    totalTokens: sum.totalTokens + (item.totalTokens || 0),
  }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 });
}

function appendMetrics(runDir, role, metrics, outcome, extra = {}) {
  const file = path.join(runDir, "metrics", `${role}.json`);
  const record = { role, outcome, endedAt: new Date().toISOString(), ...metrics, usageTotal: usageTotal(metrics), ...extra };
  const previous = fs.existsSync(file) ? readJson(file) : null;
  const attempts = previous?.attempts || (previous ? [{ ...previous, attempts: undefined }] : []);
  writeJson(file, { ...record, attempts: [...attempts, record] });
}

function nextAttemptPath(runDir, episode) {
  const dir = eventDir(runDir, episode);
  fs.mkdirSync(dir, { recursive: true });
  const count = fs.readdirSync(dir).filter((name) => /^attempt-\d+\.json$/.test(name)).length;
  return path.join(dir, `attempt-${String(count + 1).padStart(3, "0")}.json`);
}

export function extractContinuityUpdate(markdown) {
  const match = String(markdown).match(/【连续性检查】\s*\n?([\s\S]*?)(?=\n#{1,3}\s|\n【[^】]+】|$)/);
  return match?.[1]?.trim() || "";
}

export function continuityContext(runDir) {
  const contract = contractText(runDir);
  const current = fs.existsSync(currentPath(runDir))
    ? readJson(currentPath(runDir))
    : { lastEpisode: 0, snapshot: "尚无已发生的动态变化；以静态连续性合同为开篇状态。", snapshotDigest: sha("尚无已发生的动态变化；以静态连续性合同为开篇状态。") };
  return { contract, contractDigest: sha(contract), current };
}

export function continuityIsAccepted(runDir, episode, screenplayDigest) {
  const file = episodePath(runDir, episode);
  if (!fs.existsSync(file)) return false;
  const record = readJson(file);
  return record.status === "accepted" && record.screenplayDigest === screenplayDigest;
}

export function stageContinuityProposal(runDir, { episode, screenplay, proposedUpdate }) {
  const update = String(proposedUpdate || extractContinuityUpdate(screenplay)).trim();
  if (!update) throw new Error(`episode ${episode} has no continuity update`);
  const context = continuityContext(runDir);
  const record = {
    episode,
    status: "pending",
    screenplayDigest: sha(screenplay),
    hook: screenplay.match(/【本集钩子】[^\n]*/)?.[0] || "",
    proposedUpdate: update,
    contractDigest: context.contractDigest,
    previousEpisode: context.current.lastEpisode,
    previousSnapshotDigest: context.current.snapshotDigest,
    stagedAt: new Date().toISOString(),
  };
  writeJson(episodePath(runDir, episode), record);
  return record;
}

export function commitContinuityReview(runDir, { episode, screenplay, proposedUpdate, review }) {
  const context = continuityContext(runDir);
  if (!["accept", "correct", "reject"].includes(review.verdict)) throw new Error("invalid continuity verdict");
  if (review.verdict !== "reject" && context.current.lastEpisode !== episode - 1) {
    throw new Error(`continuity chain expected episode ${episode - 1}, got ${context.current.lastEpisode}`);
  }
  const event = {
    episode,
    verdict: review.verdict,
    reason: String(review.reason || "").trim(),
    proposedUpdate: String(proposedUpdate).trim(),
    approvedUpdate: String(review.approvedUpdate || "").trim(),
    currentSnapshot: String(review.currentSnapshot || "").trim(),
    screenplayDigest: sha(screenplay),
    contractDigest: context.contractDigest,
    previousSnapshotDigest: context.current.snapshotDigest,
    reviewedAt: new Date().toISOString(),
  };
  const eventFile = nextAttemptPath(runDir, episode);
  writeJson(eventFile, event);
  if (review.verdict === "reject") {
    writeJson(episodePath(runDir, episode), { ...event, status: "rejected", event: path.relative(runDir, eventFile) });
    return { accepted: false, event, eventFile };
  }
  if (event.approvedUpdate.length < 8 || event.currentSnapshot.length < 30) throw new Error("continuity review returned an incomplete update or snapshot");
  const current = {
    lastEpisode: episode,
    snapshot: event.currentSnapshot,
    snapshotDigest: sha(event.currentSnapshot),
    sourceEvent: path.relative(runDir, eventFile),
    updatedAt: event.reviewedAt,
  };
  writeJson(currentPath(runDir), current);
  writeText(path.join(runDir, "continuity", "current.md"), `# 截至第 ${episode} 集的动态连续性快照\n\n${event.currentSnapshot}`);
  writeJson(episodePath(runDir, episode), {
    episode,
    status: "accepted",
    screenplayDigest: event.screenplayDigest,
    hook: screenplay.match(/【本集钩子】[^\n]*/)?.[0] || "",
    proposedUpdate: event.proposedUpdate,
    approvedUpdate: event.approvedUpdate,
    verdict: event.verdict,
    reason: event.reason,
    contractDigest: event.contractDigest,
    previousSnapshotDigest: event.previousSnapshotDigest,
    snapshotDigest: current.snapshotDigest,
    event: current.sourceEvent,
  });
  return { accepted: true, event, eventFile, current };
}

export async function reviewContinuityUpdate(runDir, { episode, screenplay, proposedUpdate }) {
  const context = continuityContext(runDir);
  let submitted = null;
  const submit = defineTool({
    name: "submit_continuity_review",
    label: "Submit continuity review",
    description: "Accept, correct, or reject the Writer continuity update and return the complete current natural-language snapshot.",
    parameters: Type.Object({
      verdict: Type.Union([Type.Literal("accept"), Type.Literal("correct"), Type.Literal("reject")]),
      approvedUpdate: Type.String({ minLength: 2 }),
      currentSnapshot: Type.String({ minLength: 2 }),
      reason: Type.String({ minLength: 2 }),
    }),
    async execute(_id, params) {
      submitted = params;
      return { content: [{ type: "text", text: "ACCEPTED continuity review" }], details: {}, terminate: true };
    },
  });
  const role = `continuity-ep-${ep(episode)}`;
  const { session, metrics } = await createPiExperimentSession({
    runDir,
    role,
    systemPrompt: "你是 TianshuAgent 内部独立的 Continuity Agent。只维护自然语言连续性，不改写剧本。核对 Writer 提交的变化是否真的发生在本集、是否与静态合同和上一集快照冲突。区分客观事实、人物认知和仍有争议的说法；不能把怀疑写成事实，不能提前泄露尚未发生的信息。若提案基本正确可 accept；若剧本支持但表达遗漏或不准，使用 correct 并给出修正后的变化；若剧本本身与既有连续性发生无法解释的冲突，使用 reject。通过时 currentSnapshot 必须保留仍然有效的旧状态，再合并本集变化，形成供下一集直接读取的完整、简洁快照。只通过工具提交。",
    customTools: [submit],
    toolNames: ["submit_continuity_review"],
  });
  let outcome = "completed";
  try {
    await promptWithWatchdog(session, metrics, `静态连续性合同：\n${context.contract.slice(0, 18000)}\n\n上一集动态快照：\n${context.current.snapshot.slice(0, 12000)}\n\nWriter 提交的本集变化：\n${proposedUpdate}\n\n第 ${episode} 集正式剧本：\n${screenplay.slice(0, 32000)}`, 240_000);
    if (!submitted) throw new Error("continuity agent did not submit a review");
    const result = commitContinuityReview(runDir, { episode, screenplay, proposedUpdate, review: submitted });
    if (!result.accepted) throw new Error(`continuity rejected episode ${episode}: ${submitted.reason}`);
    appendMetrics(runDir, role, metrics, outcome, { verdict: submitted.verdict, event: path.relative(runDir, result.eventFile) });
    return result;
  } catch (error) {
    outcome = "failed";
    appendMetrics(runDir, role, metrics, outcome, { error: error.message });
    throw error;
  } finally {
    session.dispose();
  }
}
