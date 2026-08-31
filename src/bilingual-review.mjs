import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cells, loadManifest, readText, writeJson } from "./core.mjs";
import { Type, createPiExperimentSession, defineTool, promptWithWatchdog } from "./experiments/lib.mjs";

const ep = (value) => String(value).padStart(2, "0");

function rowMap(markdown) {
  return new Map(markdown.split("\n").filter((line) => line.startsWith("|")).map((line) => {
    const value = cells(line);
    return [value[0], value];
  }).filter(([, value]) => value.length === 7 && /^ep\d{2}-s\d{2}$/i.test(value[0])));
}

function changedRows(runDir, episode) {
  const backup = path.join(runDir, "work", "bilingual-hotfix", `ep-${ep(episode)}.before.md`);
  const current = path.join(runDir, "storyboard", `ep-${ep(episode)}.md`);
  if (!fs.existsSync(backup) || !fs.existsSync(current)) return [];
  const before = rowMap(readText(backup));
  const after = rowMap(readText(current));
  return [...after.entries()].filter(([shot, row]) => before.get(shot)?.[2] !== row[2]).map(([shot, row]) => ({
    episode,
    shotId: shot,
    visual: row[1],
    before: before.get(shot)[2],
    after: row[2],
  }));
}

export async function reviewBilingualHotfix(runDir) {
  const manifest = loadManifest(runDir);
  const findings = [];
  for (let from = 1; from <= manifest.episodes; from += 5) {
    const to = Math.min(manifest.episodes, from + 4);
    const changes = Array.from({ length: to - from + 1 }, (_, index) => from + index).flatMap((episode) => changedRows(runDir, episode));
    if (!changes.length) continue;
    let submitted = false;
    const batchFindings = [];
    const submit = defineTool({
      name: "submit_bilingual_review",
      label: "Submit bilingual hotfix review",
      description: "Submit only real meaning, speaker-attribution, or naturalness defects in the changed dialogue cells. Do not rewrite dialogue.",
      parameters: Type.Object({
        findings: Type.Array(Type.Object({
          episode: Type.Integer(),
          shotId: Type.String(),
          severity: Type.Union([Type.Literal("P1"), Type.Literal("P2")]),
          reason: Type.String(),
        })),
      }),
      async execute(_id, params) {
        const allowed = new Set(changes.map((change) => change.shotId));
        for (const finding of params.findings) {
          if (finding.episode < from || finding.episode > to || !allowed.has(finding.shotId)) return { content: [{ type: "text", text: `REJECTED finding outside changed cells: ${finding.shotId}` }], details: {}, terminate: false };
        }
        batchFindings.push(...params.findings);
        submitted = true;
        return { content: [{ type: "text", text: `ACCEPTED ${params.findings.length} findings` }], details: {}, terminate: true };
      },
    });
    const role = `bilingual-review-${from}-${to}`;
    const { session, metrics } = await createPiExperimentSession({
      runDir,
      role,
      systemPrompt: "你是独立双语台词 Reviewer。结构硬校验已经通过，你只检查修改后的中文是否准确表达英文、人物归属是否正确、是否凭空增加或删掉关键信息、中文是否明显不自然。P1=必须修复的错译或归属错误；P2=可选润色。不要重写台词，不要把纯风格偏好报成问题。检查全部给出的差异后，通过 submit_bilingual_review 提交；没有问题就提交空数组。",
      customTools: [submit],
      toolNames: ["submit_bilingual_review"],
    });
    const prompt = changes.map((change) => `### ${change.shotId}\n画面：${change.visual}\n修改前：${change.before}\n修改后：${change.after}`).join("\n\n");
    let outcome = "completed";
    try {
      await promptWithWatchdog(session, metrics, `逐项检查 EP${ep(from)}–EP${ep(to)} 的 ${changes.length} 个双语 hotfix 差异。\n\n${prompt}`, 600000);
      if (!submitted) throw new Error(`bilingual Reviewer did not submit EP${from}-${to}`);
    } catch (error) {
      outcome = "failed";
      throw error;
    } finally {
      session.dispose();
      const metricsFile = path.join(runDir, "metrics", `${role}.json`);
      const record = { role, outcome, endedAt: new Date().toISOString(), ...metrics };
      const previous = fs.existsSync(metricsFile) ? JSON.parse(readText(metricsFile)) : null;
      const attempts = previous ? (previous.attempts || [{ ...previous, attempts: undefined }]) : [];
      writeJson(metricsFile, { ...record, attempts: [...attempts, record] });
    }
    findings.push(...batchFindings);
  }
  const report = { reviewedAt: new Date().toISOString(), findings };
  writeJson(path.join(runDir, "reviews", "bilingual-hotfix-review.json"), report);
  return report;
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const runDir = path.resolve(process.argv[2] || "");
  if (!runDir || !fs.existsSync(path.join(runDir, "manifest.json"))) throw new Error("usage: node src/bilingual-review.mjs <run-dir>");
  console.log(JSON.stringify(await reviewBilingualHotfix(runDir), null, 2));
}
