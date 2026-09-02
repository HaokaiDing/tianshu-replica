import fs from "node:fs";
import path from "node:path";
import { Type, createPiExperimentSession, defineTool, promptWithWatchdog } from "./experiments/lib.mjs";
import { loadManifest, readJson, readText, sha, writeJson } from "./core.mjs";
import { loadProductionContract, productionContractDigest, productionContractMarkdown } from "./production-contract.mjs";
import { semanticRepairPlan } from "./review.mjs";
import { marketArtifactDigest } from "./market.mjs";

const ep = (value) => String(value).padStart(2, "0");

const findingShape = {
  id: Type.String({ minLength: 3 }),
  episode: Type.Integer({ minimum: 0 }),
  severity: Type.Union([Type.Literal("P0"), Type.Literal("P1"), Type.Literal("P2")]),
  scope: Type.Union([Type.Literal("local"), Type.Literal("pair"), Type.Literal("series"), Type.Literal("upstream")]),
  category: Type.String({ minLength: 2 }),
  evidence: Type.String({ minLength: 3 }),
  reason: Type.String({ minLength: 3 }),
  acceptance: Type.String({ minLength: 3 }),
  repairInstruction: Type.String({ minLength: 3 }),
  preserve: Type.Array(Type.String()),
  doNotChange: Type.Array(Type.String()),
};

const windowFindingType = Type.Object(findingShape);
const seriesFindingType = Type.Object({
  ...findingShape,
  disposition: Type.Optional(Type.Union([Type.Literal("repair"), Type.Literal("accepted_non_blocking")])),
});
const episodeSummaryType=Type.Object({episode:Type.Integer({minimum:1}),summary:Type.String({minLength:20}),hook:Type.String({minLength:3}),endingState:Type.String({minLength:3}),promotionalBeat:Type.String({minLength:3})});

export function assertReviewerSubmitted(submitted, label) {
  if (!submitted) throw new Error(`${label} did not submit`);
}

function appendMetrics(runDir, role, metrics, outcome, extra = {}) {
  const file = path.join(runDir, "metrics", `${role}.json`);
  const record = { role, outcome, endedAt: new Date().toISOString(), ...metrics, ...extra };
  const previous = fs.existsSync(file) ? readJson(file) : null;
  const attempts = previous?.attempts || (previous ? [{ ...previous, attempts: undefined }] : []);
  writeJson(file, { ...record, attempts: [...attempts, record] });
}

function planningPayload(runDir) {
  return ["acts.md", "design.md", "outline.md", "characters.md", "ledger.json", "continuity-contract.md", "market.json", "market-contract.md"]
    .map((name) => {
      const file = path.join(runDir, "canonical", name);
      return fs.existsSync(file) ? `## ${name}\n${readText(file)}` : `## ${name}\n[MISSING]`;
    }).join("\n\n");
}

function canonicalReviewContext(runDir) {
  return ["production-contract.json","market.json","market-contract.md","acts.md","design.md","outline.md","characters.md","ledger.json","continuity-contract.md"]
    .map((name)=>{const file=path.join(runDir,"canonical",name);return fs.existsSync(file)?`## ${name}\n${readText(file)}`:"";}).filter(Boolean).join("\n\n");
}

export function episodePayload(runDir, stage, episode) {
  const screenplayFile = path.join(runDir, "screenplay", `ep-${ep(episode)}.md`);
  const screenplay = fs.existsSync(screenplayFile) ? readText(screenplayFile) : "[MISSING SCREENPLAY]";
  if (stage === "screenplay") return `# EP${ep(episode)}\n${screenplay}`;
  const storyboardFile = path.join(runDir, "storyboard", `ep-${ep(episode)}.md`);
  const storyboard = fs.existsSync(storyboardFile) ? readText(storyboardFile) : "[MISSING STORYBOARD]";
  return `# EP${ep(episode)} SOURCE SCREENPLAY\n${screenplay}\n\n# EP${ep(episode)} STORYBOARD\n${storyboard}`;
}

export function stageArtifactDigest(runDir, stage) {
  const manifest = loadManifest(runDir);
  if (stage === "planning") return sha(planningPayload(runDir));
  const rows = [];
  for (let episode = 1; episode <= manifest.episodes; episode++) {
    const file = path.join(runDir, stage, `ep-${ep(episode)}.md`);
    if (!fs.existsSync(file)) throw new Error(`missing ${stage} episode ${episode}`);
    rows.push(`${episode}:${sha(readText(file))}`);
    if (stage === "storyboard") {
      const source = path.join(runDir, "screenplay", `ep-${ep(episode)}.md`);
      if (!fs.existsSync(source)) throw new Error(`missing screenplay episode ${episode}`);
      rows.push(`source-${episode}:${sha(readText(source))}`);
    }
  }
  return sha(rows.join("\n"));
}

function reviewPrompt(stage, contractText) {
  const stageRules = stage === "planning"
    ? "检查题材承诺、女主能动性、前三集宣发钩子、全季升级线、目标市场、人物和账本是否自洽。规划尚未获用户批准，可以要求 Planner 修订上游内容。"
    : stage === "screenplay"
      ? "检查真实剧情、跨集连续性、因果代价、人物能动性、自然双语、市场制度和每集结尾钩子。不要把纯偏好报成缺陷。"
      : "逐镜对照源剧本，检查信息遗漏或篡改、前几集冷开与可剪宣发桥段、节奏时长、动作反应、连续性、双语、可拍性和安全边界。";
  return `你是 TianshuAgent 内部独立 Reviewer，只审不写。${stageRules}\n\n${contractText}\n\n每个 finding 必须有稳定 id、category、原文证据、明确修复验收标准、修复指令以及必须保留/不得改动的内容。P0=必须改已批准合同或系统性根基；P1=交付前必须修；P2=真实但非阻断问题。没有问题也必须调用提交工具并提交空数组。禁止用“符合要求”“没有问题”制造 P2。`;
}

async function reviewWindow(runDir, stage, from, to, contractText, cycle) {
  let submitted = false;
  let findings = [];
  let summary="",episodeSummaries=[];
  const submit = defineTool({
    name: "submit_review",
    label: "Submit window review",
    description: "Submit every real finding in this review window, including an explicit empty array when clean.",
    parameters: Type.Object({ summary:Type.String({minLength:10}),episodeSummaries:Type.Array(episodeSummaryType,{minItems:to-from+1,maxItems:to-from+1}),findings: Type.Array(windowFindingType) }),
    async execute(_id, params) {
      const expected=Array.from({length:to-from+1},(_,index)=>from+index),received=params.episodeSummaries.map((item)=>item.episode);if(expected.join(",")!==received.join(","))return {content:[{type:"text",text:"REJECTED episode summaries must cover the review window in order"}],details:{expected,received},terminate:false};
      for (const finding of params.findings) {
        if (finding.episode < from || finding.episode > to) {
          return { content: [{ type: "text", text: "REJECTED finding outside review window" }], details: {}, terminate: false };
        }
      }
      submitted = true;
      findings = params.findings;
      summary=params.summary;episodeSummaries=params.episodeSummaries;
      return { content: [{ type: "text", text: `ACCEPTED ${findings.length} window findings` }], details: {}, terminate: true };
    },
  });
  const role = `${stage}-window-review-${from}-${to}-cycle-${cycle}`;
  const { session, metrics } = await createPiExperimentSession({
    runDir,
    role,
    systemPrompt: `${reviewPrompt(stage, contractText)}\n\n窗口审稿必须为窗口内每一集提交摘要、结尾状态、钩子和可剪宣发桥段；这些带 artifact digest 的摘要会交给独立全剧 Reviewer 做跨集审查。`,
    customTools: [submit],
    toolNames: ["submit_review"],
  });
  let outcome = "completed";
  try {
    const payload = Array.from({ length: to - from + 1 }, (_, index) => episodePayload(runDir, stage, from + index)).join("\n\n---\n\n");
    await promptWithWatchdog(session, metrics, `Canonical context:\n${canonicalReviewContext(runDir)}\n\nReview window:\n${payload}`, 900_000);
    assertReviewerSubmitted(submitted,`${stage} window Reviewer EP${from}-${to}`);
    return {from,to,summary,episodeSummaries,findings,artifactDigest:sha(payload)};
  } catch (error) {
    outcome = "failed";
    throw error;
  } finally {
    session.dispose();
    appendMetrics(runDir, role, metrics, outcome);
  }
}

async function reviewSeries(runDir, stage, windowReviews, contractText, cycle) {
  const manifest = loadManifest(runDir);
  let submitted = false;
  let findings = [];
  let summary = "";
  const submit = defineTool({
    name: "submit_series_review",
    label: "Submit final series review",
    description: "Submit the independent final findings and explicit P2 dispositions for the current artifacts.",
    parameters: Type.Object({ summary: Type.String({ minLength: 3 }), findings: Type.Array(seriesFindingType) }),
    async execute(_id, params) {
      submitted = true;
      findings = params.findings;
      summary = params.summary;
      return { content: [{ type: "text", text: `ACCEPTED ${findings.length} final findings` }], details: {}, terminate: true };
    },
  });
  const role = `${stage}-series-review-cycle-${cycle}`;
  const { session, metrics } = await createPiExperimentSession({
    runDir,
    role,
    systemPrompt: `${reviewPrompt(stage, contractText)}\n\n你是全剧终审，与创作 Agent 和窗口 Reviewer 使用全新的独立 session。窗口 findings 只是线索，必须复核后自行决定保留、删除或补充。每个 P2 必须选择 repair 或 accepted_non_blocking；P0/P1 的 disposition 固定填 repair。`,
    customTools: [submit],
    toolNames: ["submit_series_review"],
  });
  let outcome = "completed";
  try {
    const body = stage === "planning" ? planningPayload(runDir) : `Canonical context:\n${canonicalReviewContext(runDir)}\n\nDigest-bound window reports:\n${JSON.stringify(windowReviews)}`;
    await promptWithWatchdog(session, metrics, `当前全剧审稿材料：\n${body}`, 1_800_000);
    assertReviewerSubmitted(submitted,`${stage} series Reviewer`);
    return { findings, summary };
  } catch (error) {
    outcome = "failed";
    throw error;
  } finally {
    session.dispose();
    appendMetrics(runDir, role, metrics, outcome);
  }
}

export async function reviewStage(runDir, stage) {
  if (!["planning", "screenplay", "storyboard"].includes(stage)) throw new Error(`unsupported review stage ${stage}`);
  const manifest = loadManifest(runDir);
  const contract = loadProductionContract(runDir);
  const contractDigest = productionContractDigest(contract);
  const contractText = `${productionContractMarkdown(contract)}\n\n${readText(path.join(runDir,"canonical","market-contract.md"))}`;
  const reviewState = manifest.reviewCycles || {};
  const cycle = Number(reviewState[stage] || 0) + 1;
  const maxCycles = contract.revision.maxSemanticRounds[stage];
  const priorFile = path.join(runDir, "reviews", `${stage}-round-${cycle - 1}.json`);
  const priorFindingIds = fs.existsSync(priorFile)
    ? readJson(priorFile).plan?.findings?.filter((finding) => finding.disposition !== "accepted_non_blocking").map((finding) => finding.id) || []
    : [];
  const artifactDigest = stageArtifactDigest(runDir, stage);
  const marketDigest = marketArtifactDigest(runDir);
  const windowReviews = [];
  if (stage !== "planning") {
    for (let from = 1; from <= manifest.episodes; from += 5) {
      windowReviews.push(await reviewWindow(runDir, stage, from, Math.min(manifest.episodes, from + 4), contractText, cycle));
    }
  }
  const windowFindings=windowReviews.flatMap((review)=>review.findings),finalReview = await reviewSeries(runDir, stage, windowReviews, contractText, cycle);
  const plan = semanticRepairPlan(finalReview.findings, {
    stage,
    totalEpisodes: manifest.episodes,
    cycle,
    maxCycles,
    systemicEpisodeThreshold: contract.revision.systemicEpisodeThreshold,
    priorFindingIds,
    requireP2Disposition:contract.revision.requireP2Disposition,
    artifactDigest,
    contractDigest,
    marketDigest,
  });
  const report = {
    stage,
    cycle,
    reviewedAt: new Date().toISOString(),
    artifactDigest,
    contractDigest,
    marketDigest,
    windowFindings,
    windowReviews,
    summary: finalReview.summary,
    plan,
  };
  writeJson(path.join(runDir, "reviews", `${stage}-round-${cycle}.json`), report);
  writeJson(path.join(runDir, "reviews", `${stage}-latest.json`), report);
  manifest.reviewCycles = { ...reviewState, [stage]: cycle };
  if (plan.action === "pass") writeJson(path.join(runDir, "reviews", `${stage}-final.json`), report);
  manifest.state = plan.action === "blocked" ? "needs_human_review" : manifest.state;
  if (plan.action === "blocked") manifest.note = `${stage} review blocked: ${plan.reasons.map((reason) => reason.reason).join("; ")}`;
  writeJson(path.join(runDir, "manifest.json"), { ...manifest, updatedAt: new Date().toISOString() });
  return report;
}
