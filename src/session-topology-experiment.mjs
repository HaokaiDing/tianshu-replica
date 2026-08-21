import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import {
  createAgentSession,
  createExtensionRuntime,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const require = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { Type } = require("typebox");
const { defineTool } = await import("@earendil-works/pi-coding-agent");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_PATH = path.join(ROOT, "fixtures", "session-topology-5ep-v1.json");
const EXPERIMENT_ROOT = path.join(ROOT, "experiments", "session-topology");
const STORYBOARD_HEADER = [
  "镜头号",
  "叙事功能",
  "画面描述",
  "英中双语台词",
  "运镜/景别/机位",
  "关键道具/信息点",
  "连续性继承",
  "角色视觉提示 / 场景视觉提示",
  "SFX/备注",
  "建议时长(s)",
  "累计时长(s)",
];

function parseArgs(args) {
  const options = { mode: "full", arm: "both", replicate: 1, trial: `trial-${new Date().toISOString().replace(/[:.]/g, "-")}` };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--mode") options.mode = args[++i];
    else if (arg === "--arm") options.arm = args[++i];
    else if (arg === "--replicate") options.replicate = Number(args[++i]);
    else if (arg === "--trial") options.trial = args[++i];
    else if (arg === "--help") {
      console.log("Usage: npm run experiment:session -- [--mode smoke|full] [--arm persistent|stateless|both] [--replicate N] [--trial ID]");
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!["smoke", "full"].includes(options.mode)) throw new Error("--mode must be smoke or full");
  if (!["persistent", "stateless", "both"].includes(options.arm)) throw new Error("--arm must be persistent, stateless, or both");
  if (!Number.isInteger(options.replicate) || options.replicate < 1) throw new Error("--replicate must be a positive integer");
  return options;
}

function sha(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporary, file);
}

function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, text.trimEnd() + "\n");
  fs.renameSync(temporary, file);
}

function text(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}

function armLabel(arm) {
  return arm === "persistent" ? "A-persistent" : "B-stateless";
}

function episodePath(runDir, stage, episode) {
  return path.join(runDir, stage, `ep-${String(episode).padStart(2, "0")}.md`);
}

function continuityPath(runDir, episode) {
  return path.join(runDir, "continuity", `ep-${String(episode).padStart(2, "0")}.json`);
}

function contextFor({ fixture, runDir, stage, episode }) {
  const current = fixture.episodes.find((item) => item.episode === episode);
  const previous = fixture.episodes.find((item) => item.episode === episode - 1);
  const next = fixture.episodes.find((item) => item.episode === episode + 1);
  const previousContinuity = previous ? readJsonIfPresent(continuityPath(runDir, previous.episode)) : null;
  const screenplay = stage === "storyboard" ? text(episodePath(runDir, "screenplay", episode)) : "";
  const anchor = text(episodePath(runDir, "screenplay", 1));
  const bundle = {
    contractVersion: "session-topology-v1",
    stage,
    episode,
    title: fixture.title,
    titleZh: fixture.titleZh,
    acts: fixture.acts,
    design: fixture.design,
    characters: fixture.characters,
    ledger: fixture.ledger,
    previousOutline: previous || null,
    currentOutline: current,
    nextOutline: next || null,
    previousContinuity,
    styleAnchor: episode > 1 ? anchor.slice(0, 8000) : null,
    screenplay: screenplay || null,
  };
  return { bundle, digest: sha(stable(bundle)) };
}

function readJsonIfPresent(file) {
  return fs.existsSync(file) ? readJson(file) : null;
}

function screenplayChecks(markdown, episode) {
  const errors = [];
  if (!new RegExp(`第\\s*${episode}\\s*集`).test(markdown)) errors.push(`缺少第${episode}集标题`);
  if (markdown.length < 900) errors.push("剧本少于 900 字，疑似残桩或内容不足");
  if (!markdown.includes("【本集钩子】")) errors.push("缺少【本集钩子】");
  if (!markdown.includes("【连续性检查】")) errors.push("缺少【连续性检查】");
  if (!/(EN:|English:)/i.test(markdown)) errors.push("缺少英文对白标记");
  return errors;
}

function tableCells(line) {
  return line.trim().split("|").slice(1, -1).map((cell) => cell.trim());
}

function storyboardChecks(markdown, episode) {
  const errors = [];
  const lines = markdown.split("\n").filter((line) => line.trim());
  const headerIndex = lines.findIndex((line) => line.startsWith("|") && tableCells(line).join("|") === STORYBOARD_HEADER.join("|"));
  if (headerIndex < 0) return ["缺少固定 11 列表头或列顺序错误"];
  const rows = lines.slice(headerIndex + 2).filter((line) => /^\|/.test(line) && !/^\|\s*[-:]+/.test(line));
  if (rows.length < 12 || rows.length > 20) errors.push(`镜头数 ${rows.length}，应为 12–20`);
  let expected = 1;
  let priorCum = 0;
  for (const row of rows) {
    const cells = tableCells(row);
    if (cells.length !== 11) { errors.push("存在非 11 列镜头行"); continue; }
    if (Number(cells[0]) !== expected) errors.push(`镜号 ${cells[0]}，应为 ${expected}`);
    expected += 1;
    const duration = Number(cells[9].match(/\d+(?:\.\d+)?/)?.[0]);
    const cumulative = Number(cells[10].match(/\d+(?:\.\d+)?/)?.[0]);
    if (!Number.isFinite(duration) || duration < 3 || duration > 7) errors.push(`镜号 ${cells[0]} 建议时长无效`);
    if (!Number.isFinite(cumulative) || cumulative <= priorCum) errors.push(`镜号 ${cells[0]} 累计时长无效`);
    priorCum = cumulative;
  }
  if (priorCum < 55 || priorCum > 95) errors.push(`总时长 ${priorCum}s，应为 55–95s`);
  if (!markdown.includes(`第${episode}集`) && !markdown.includes(`第 ${episode} 集`)) errors.push(`缺少第${episode}集标识`);
  return [...new Set(errors)];
}

function continuityFrom(markdown, fixture, episode) {
  const hook = markdown.match(/【本集钩子】[：:]?\s*([^\n]+)/)?.[1]?.trim() || "未提取到钩子";
  const excerpt = markdown.split("\n").filter(Boolean).slice(-14).join("\n").slice(0, 1800);
  return {
    episode,
    hook,
    canonicalNames: fixture.ledger.canonicalNames,
    makerMark: fixture.ledger.makerMark,
    excerpt,
    sourceDigest: sha(markdown),
  };
}

function systemPrompt(role) {
  const common = `你在进行一个受控的短剧创作实验。项目事实由用户消息中的 Context Bundle 提供；不得自行发明人名、编号、世界规则或替代上游事件。任何通过 submit_* 写入的内容都是正式候选，错误时按工具返回的具体问题修正。不要使用 bash、write、edit 或任何未列出的工具。不要调用 run_checks；submit_* 会运行同一套检查并返回可修复的错误。`;
  if (role === "writer") return `${common}\n\n你是剧本作者。为指定集生成完整、可拍的双语剧本。每句主要对白写成“角色：EN: English line / 中：中文译文”。用动作外化情绪。结尾必须包含【本集钩子】与【连续性检查】。完成后立即调用 submit_screenplay；只有它被拒绝时才修改后重新提交。`;
  if (role === "storyboard") return `${common}\n\n你是分镜导演。只依据本集已定稿剧本拆分分镜。禁止使用“场景/景别/拍摄角度”等常见分镜列来替换本合同。必须输出下列唯一固定 11 列 Markdown 表头，列名与顺序逐字一致：\n| ${STORYBOARD_HEADER.join(" | ")} |\n\n12–20 镜，每镜 3–7 秒，总时长 55–95 秒；镜号从 1 连续递增，累计时长严格递增。画面描述写清人物、动作、对象与镜末状态。完成后立即调用 submit_storyboard；只有它被拒绝时才修改后重新提交。`;
  return `${common}\n\n你是独立审稿人。只检查实际产物和上下文，不重写作品。列出 blocker、warning 与具体集号，并调用 submit_review。`;
}

function resourceLoader(role) {
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt(role),
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

function makeTools({ fixture, runDir, task, metrics }) {
  const getContext = defineTool({
    name: "get_context",
    label: "Get context",
    description: "Return the canonical, minimal context bundle for the current stage and episode. Call this before writing.",
    parameters: Type.Object({}),
    executionMode: "sequential",
    async execute() {
      const compiled = contextFor({ fixture, runDir, stage: task.stage, episode: task.episode });
      task.contextDigest = compiled.digest;
      return {
        content: [{ type: "text", text: `contextDigest=${compiled.digest}\n${JSON.stringify(compiled.bundle, null, 2)}` }],
        details: { digest: compiled.digest, stage: task.stage, episode: task.episode },
      };
    },
  });

  const runChecks = defineTool({
    name: "run_checks",
    label: "Run checks",
    description: "Validate a candidate Markdown document before submission. Use this to diagnose a draft.",
    parameters: Type.Object({ markdown: Type.String({ minLength: 1 }) }),
    executionMode: "sequential",
    async execute(_id, params) {
      const errors = task.stage === "storyboard"
        ? storyboardChecks(params.markdown, task.episode)
        : screenplayChecks(params.markdown, task.episode);
      return { content: [{ type: "text", text: errors.length ? `FAIL: ${errors.join("；")}` : "PASS" }], details: { errors } };
    },
  });

  const submitScreenplay = defineTool({
    name: "submit_screenplay",
    label: "Submit screenplay",
    description: "Submit the current episode screenplay. It is accepted only when the context digest and hard checks match.",
    parameters: Type.Object({
      episode: Type.Integer(),
      contextDigest: Type.String(),
      markdown: Type.String({ minLength: 1 }),
    }),
    executionMode: "sequential",
    async execute(_id, params) {
      if (task.stage !== "writer") return { content: [{ type: "text", text: "ERROR: submit_screenplay is unavailable for this task" }], details: {}, terminate: false };
      const errors = [];
      if (params.episode !== task.episode) errors.push(`当前任务是第${task.episode}集`);
      if (params.contextDigest !== task.contextDigest) errors.push("contextDigest 已过期；请重新调用 get_context");
      errors.push(...screenplayChecks(params.markdown, task.episode));
      if (errors.length) {
        task.attempt = (task.attempt || 0) + 1;
        writeText(path.join(runDir, "attempts", `screenplay-ep${String(task.episode).padStart(2, "0")}-attempt${task.attempt}.md`), params.markdown);
        console.log(`[writer:ep${task.episode}] rejected: ${[...new Set(errors)].join("；")}`);
        return { content: [{ type: "text", text: `REJECTED: ${[...new Set(errors)].join("；")}` }], details: { errors }, terminate: false };
      }
      writeText(episodePath(runDir, "screenplay", task.episode), params.markdown);
      writeJson(continuityPath(runDir, task.episode), continuityFrom(params.markdown, fixture, task.episode));
      return { content: [{ type: "text", text: `ACCEPTED screenplay ep${task.episode}` }], details: { episode: task.episode }, terminate: true };
    },
  });

  const submitStoryboard = defineTool({
    name: "submit_storyboard",
    label: "Submit storyboard",
    description: "Submit the current fixed-11-column storyboard. It is accepted only when the context digest and hard checks match.",
    parameters: Type.Object({
      episode: Type.Integer(),
      contextDigest: Type.String(),
      markdown: Type.String({ minLength: 1 }),
    }),
    executionMode: "sequential",
    async execute(_id, params) {
      if (task.stage !== "storyboard") return { content: [{ type: "text", text: "ERROR: submit_storyboard is unavailable for this task" }], details: {}, terminate: false };
      const errors = [];
      if (params.episode !== task.episode) errors.push(`当前任务是第${task.episode}集`);
      if (params.contextDigest !== task.contextDigest) errors.push("contextDigest 已过期；请重新调用 get_context");
      errors.push(...storyboardChecks(params.markdown, task.episode));
      if (errors.length) {
        task.attempt = (task.attempt || 0) + 1;
        writeText(path.join(runDir, "attempts", `storyboard-ep${String(task.episode).padStart(2, "0")}-attempt${task.attempt}.md`), params.markdown);
        console.log(`[storyboard:ep${task.episode}] rejected: ${[...new Set(errors)].join("；")}`);
        return { content: [{ type: "text", text: `REJECTED: ${[...new Set(errors)].join("；")}` }], details: { errors }, terminate: false };
      }
      writeText(episodePath(runDir, "storyboard", task.episode), params.markdown);
      return { content: [{ type: "text", text: `ACCEPTED storyboard ep${task.episode}` }], details: { episode: task.episode }, terminate: true };
    },
  });

  const submitReview = defineTool({
    name: "submit_review",
    label: "Submit review",
    description: "Submit a concise independent review for the current 5-episode candidate.",
    parameters: Type.Object({
      verdict: Type.Union([Type.Literal("pass"), Type.Literal("minor"), Type.Literal("major")]),
      blockers: Type.Array(Type.String()),
      warnings: Type.Array(Type.String()),
      summary: Type.String({ minLength: 20 }),
    }),
    executionMode: "sequential",
    async execute(_id, params) {
      writeJson(path.join(runDir, "review.json"), params);
      return { content: [{ type: "text", text: "ACCEPTED review" }], details: params, terminate: true };
    },
  });

  return [getContext, runChecks, submitScreenplay, submitStoryboard, submitReview];
}

async function createSession({ runtime, model, fixture, runDir, task, role, metrics }) {
  const sessionMetrics = { role, prompts: 0, turns: 0, toolStarts: 0, toolEnds: 0, compactions: 0, textChars: 0, usage: [] };
  metrics.sessions.push(sessionMetrics);
  const { session } = await createAgentSession({
    cwd: ROOT,
    agentDir: path.join(runDir, ".pi-agent"),
    modelRuntime: runtime,
    model,
    thinkingLevel: "off",
    resourceLoader: resourceLoader(role),
    tools: ["submit_screenplay", "submit_storyboard", "submit_review"],
    customTools: makeTools({ fixture, runDir, task, metrics }),
    sessionManager: SessionManager.inMemory(ROOT),
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: true, maxRetries: 1 } }),
  });
  session.subscribe((event) => {
    if (event.type === "turn_end") sessionMetrics.turns += 1;
    if (event.type === "tool_execution_start") {
      sessionMetrics.toolStarts += 1;
      console.log(`[${role}:ep${task.episode}] tool start ${event.toolName}`);
      if (sessionMetrics.toolStarts > 5) {
        console.log(`[${role}:ep${task.episode}] aborting after tool-call budget exceeded`);
        void session.abort();
      }
    }
    if (event.type === "tool_execution_end") {
      sessionMetrics.toolEnds += 1;
      console.log(`[${role}:ep${task.episode}] tool ${event.isError ? "error" : "ok"} ${event.toolName}`);
    }
    if (event.type === "compaction_end") sessionMetrics.compactions += 1;
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") sessionMetrics.textChars += event.assistantMessageEvent.delta.length;
    if (event.type === "message_end" && event.message?.role === "assistant" && event.message?.usage) {
      const usage = event.message.usage;
      sessionMetrics.usage.push({
        input: usage.input ?? null,
        output: usage.output ?? null,
        cacheRead: usage.cacheRead ?? null,
        cacheWrite: usage.cacheWrite ?? null,
        totalTokens: usage.totalTokens ?? null,
      });
    }
    if (event.type === "agent_end") console.log(`[${role}:ep${task.episode}] agent end`);
  });
  return { session, sessionMetrics };
}

async function promptEpisode(session, task, role, { fixture, runDir, recovery = false } = {}) {
  const label = role === "writer" ? "完整双语剧本" : "固定 11 列分镜";
  const compiled = contextFor({ fixture, runDir, stage: task.stage, episode: task.episode });
  task.contextDigest = compiled.digest;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void session.abort();
  }, 180_000);
  try {
    const recoveryInstruction = recovery
      ? `上一轮没有调用提交工具。本轮不要解释、不要只给正文；必须调用对应 submit 工具。`
      : `创作本集${label}。只在完全满足工具校验时调用对应 submit 工具。`;
    await session.prompt(`现在处理第${task.episode}集。${recoveryInstruction}\n\n【Context Bundle｜digest=${compiled.digest}】\n${JSON.stringify(compiled.bundle)}`);
  } finally {
    clearTimeout(timer);
  }
  if (timedOut) throw new Error(`第${task.episode}集 ${role} 超过 180 秒无完成，已由 watchdog 中止`);
}

function ensure(file, description) {
  if (!fs.existsSync(file)) throw new Error(`${description} 未被 Agent 成功提交：${file}`);
}

function reviewContext(fixture, runDir) {
  const artifacts = fixture.episodes.map(({ episode }) => ({
    episode,
    outline: fixture.episodes.find((item) => item.episode === episode),
    screenplay: text(episodePath(runDir, "screenplay", episode)),
    storyboard: text(episodePath(runDir, "storyboard", episode)),
    continuity: readJsonIfPresent(continuityPath(runDir, episode)),
  }));
  return { title: fixture.title, ledger: fixture.ledger, artifacts };
}

async function runReview({ runtime, model, fixture, runDir, metrics }) {
  const task = { stage: "review", episode: 0, contextDigest: "review" };
  const { session } = await createSession({ runtime, model, fixture, runDir, task, role: "reviewer", metrics });
  const payload = reviewContext(fixture, runDir);
  try {
    await session.prompt(`审查以下候选。不要因为标签或 session 策略偏袒任何输出；只判内容。重点查跨集钩子、人名/道具一致性、女主主动性、11 列分镜可拍性。\n\n${JSON.stringify(payload)}`);
  } finally {
    session.dispose();
  }
  ensure(path.join(runDir, "review.json"), "独立审稿报告");
}

function renderDeliverables(fixture, runDir) {
  const title = `${fixture.title}（${fixture.titleZh}）`;
  const markdown = fixture.episodes.map(({ episode }) => text(episodePath(runDir, "storyboard", episode))).join("\n\n---\n\n");
  const deliverDir = path.join(runDir, "deliverables");
  const mdPath = path.join(deliverDir, `${title}｜分镜剧本.md`);
  writeText(mdPath, markdown);
  const docxPath = path.join(deliverDir, `${title}｜分镜剧本.docx`);
  const { execFileSync } = require("node:child_process");
  execFileSync("textutil", ["-convert", "docx", "-output", docxPath, mdPath]);
  return { markdown: mdPath, docx: docxPath };
}

async function executeArm({ arm, replicate, mode, trial, fixture, runtime, model }) {
  const runId = `${fixture.id}__${trial}__${arm}__r${replicate}`;
  const runDir = path.join(EXPERIMENT_ROOT, runId);
  if (fs.existsSync(runDir)) throw new Error(`实验目录已存在，拒绝覆盖：${runDir}`);
  const metrics = { arm, replicate, mode, model: "kimi-coding/k3-256k", startedAt: new Date().toISOString(), sessions: [], episodes: [], errors: [] };
  writeJson(path.join(runDir, "fixture-manifest.json"), { fixtureId: fixture.id, fixtureDigest: sha(stable(fixture)), arm, replicate, mode });
  const episodes = mode === "smoke" ? fixture.episodes.slice(0, 1) : fixture.episodes;
  const started = performance.now();
  try {
  for (const [stage, role] of [["writer", "writer"], ["storyboard", "storyboard"]]) {
    let persistent = null;
    let task = { stage, episode: 0, contextDigest: null };
    try {
      if (arm === "persistent") persistent = await createSession({ runtime, model, fixture, runDir, task, role, metrics });
      for (const { episode } of episodes) {
        task.stage = stage;
        task.episode = episode;
        task.contextDigest = null;
        task.attempt = 0;
        const episodeStarted = performance.now();
        const output = episodePath(runDir, stage === "writer" ? "screenplay" : "storyboard", episode);
        let accepted = false;
        let recoveries = 0;
        for (let attempt = 0; attempt < 2 && !accepted; attempt += 1) {
          const one = persistent || await createSession({ runtime, model, fixture, runDir, task, role, metrics });
          try {
            one.sessionMetrics.prompts += 1;
            await promptEpisode(one.session, task, role, { fixture, runDir, recovery: attempt > 0 });
            accepted = fs.existsSync(output);
            if (!accepted && attempt === 0) {
              recoveries += 1;
              console.log(`[${role}:ep${episode}] no submission; applying the single allowed recovery`);
            }
          } finally {
            if (!persistent) one.session.dispose();
          }
        }
        ensure(output, `${stage} 第${episode}集`);
        metrics.episodes.push({ stage, episode, elapsedMs: Math.round(performance.now() - episodeStarted), status: "accepted", recoveries });
      }
    } catch (error) {
      metrics.errors.push({ stage, message: String(error?.message || error) });
      throw error;
    } finally {
      persistent?.session.dispose();
    }
  }
  if (mode === "full") await runReview({ runtime, model, fixture, runDir, metrics });
  const deliverables = renderDeliverables(fixture, runDir);
  metrics.elapsedMs = Math.round(performance.now() - started);
  metrics.finishedAt = new Date().toISOString();
  metrics.outcome = "passed";
  metrics.deliverables = deliverables;
  writeJson(path.join(runDir, "metrics.json"), metrics);
  return { runId, runDir, metrics, deliverables };
  } catch (error) {
    metrics.elapsedMs = Math.round(performance.now() - started);
    metrics.finishedAt = new Date().toISOString();
    metrics.outcome = "failed";
    metrics.failure = String(error?.message || error);
    writeJson(path.join(runDir, "metrics.json"), metrics);
    throw error;
  }
}

function summarize(results) {
  const rows = results.map(({ runId, metrics }) => ({
    runId,
    arm: metrics.arm,
    replicate: metrics.replicate,
    elapsedMs: metrics.elapsedMs,
    sessions: metrics.sessions.length,
    turns: metrics.sessions.reduce((sum, item) => sum + item.turns, 0),
    toolCalls: metrics.sessions.reduce((sum, item) => sum + item.toolEnds, 0),
    compactions: metrics.sessions.reduce((sum, item) => sum + item.compactions, 0),
    accepted: metrics.episodes.filter((item) => item.status === "accepted").length,
    review: readJsonIfPresent(path.join(path.dirname(results.find((result) => result.runId === runId).deliverables.markdown), "..", "review.json"))?.verdict || "not-run",
  }));
  return { generatedAt: new Date().toISOString(), rows };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const fixture = readJson(FIXTURE_PATH);
  fs.mkdirSync(EXPERIMENT_ROOT, { recursive: true });
  const runtime = await ModelRuntime.create();
  const model = runtime.getModel("kimi-coding", "k3-256k");
  if (!model) throw new Error("Pi 未解析到 kimi-coding/k3-256k；请运行 pi auth check --model kimi-coding/k3-256k --json --no-refresh");
  const arms = options.arm === "both" ? ["persistent", "stateless"] : [options.arm];
  const results = [];
  for (let replicate = 1; replicate <= options.replicate; replicate += 1) {
    for (const arm of arms) {
      console.log(`\n=== ${armLabel(arm)} replicate ${replicate} (${options.mode}) ===`);
      results.push(await executeArm({ arm, replicate, mode: options.mode, trial: options.trial, fixture, runtime, model }));
    }
  }
  const summary = summarize(results);
  const summaryPath = path.join(EXPERIMENT_ROOT, `summary-${Date.now()}.json`);
  writeJson(summaryPath, summary);
  console.log(JSON.stringify({ summaryPath, ...summary }, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
