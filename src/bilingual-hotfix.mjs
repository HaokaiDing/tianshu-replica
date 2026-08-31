import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dialogueCellErrors } from "./bilingual.mjs";
import { cells, checkStoryboard, loadManifest, readText, sha, taskPath, writeJson, writeText } from "./core.mjs";
import { Type, createPiExperimentSession, defineTool, promptWithWatchdog } from "./experiments/lib.mjs";

const ep = (value) => String(value).padStart(2, "0");

function storyboardRows(markdown) {
  return markdown.split("\n").map((line) => {
    if (!line.startsWith("|") || /^\|\s*[-:]+/.test(line)) return null;
    const value = cells(line);
    return value.length === 7 && /^ep\d{2}-s\d{2}$/i.test(value[0]) ? value : null;
  }).filter(Boolean);
}

function failingRows(markdown) {
  return storyboardRows(markdown).map((row) => ({
    shotId: row[0],
    visual: row[1],
    dialogue: row[2],
    errors: dialogueCellErrors(row[2], row[0]),
  })).filter((row) => row.errors.length);
}

function applyReplacements(markdown, replacements) {
  return markdown.split("\n").map((line) => {
    if (!line.startsWith("|") || /^\|\s*[-:]+/.test(line)) return line;
    const value = cells(line);
    const dialogue = value.length === 7 ? replacements.get(value[0]) : null;
    if (!dialogue) return line;
    value[2] = dialogue;
    return `| ${value.join(" | ")} |`;
  }).join("\n");
}

async function repairEpisode(runDir, episode) {
  const boardFile = path.join(runDir, "storyboard", `ep-${ep(episode)}.md`);
  const screenplayFile = path.join(runDir, "screenplay", `ep-${ep(episode)}.md`);
  if (!fs.existsSync(boardFile)) throw new Error(`missing storyboard EP${ep(episode)}`);
  const before = readText(boardFile);
  const failures = failingRows(before);
  if (!failures.length) return { episode, outcome: "already-clean", repaired: 0 };

  let accepted = false;
  let repaired = 0;
  const submit = defineTool({
    name: "submit_bilingual_repairs",
    label: "Submit bilingual dialogue repairs",
    description: "Submit only replacement dialogue cells for every requested shot. Other storyboard columns cannot be changed.",
    parameters: Type.Object({
      episode: Type.Integer(),
      repairs: Type.Array(Type.Object({ shotId: Type.String(), dialogue: Type.String({ minLength: 8 }) })),
    }),
    async execute(_id, params) {
      if (params.episode !== episode) return { content: [{ type: "text", text: `REJECTED wrong episode; expected ${episode}` }], details: {}, terminate: false };
      const expected = failures.map((row) => row.shotId).sort();
      const received = params.repairs.map((row) => row.shotId).sort();
      if (new Set(received).size !== received.length || expected.join("|") !== received.join("|")) {
        return { content: [{ type: "text", text: `REJECTED repair set must exactly match ${expected.join(", ")}` }], details: { expected, received }, terminate: false };
      }
      const replacements = new Map();
      const errors = [];
      for (const repair of params.repairs) {
        if (/[|\n\r]/.test(repair.dialogue)) errors.push(`${repair.shotId}: dialogue must be one Markdown cell and use <br> for line breaks`);
        errors.push(...dialogueCellErrors(repair.dialogue, repair.shotId));
        replacements.set(repair.shotId, repair.dialogue.trim());
      }
      if (errors.length) return { content: [{ type: "text", text: `REJECTED ${[...new Set(errors)].join("；")}` }], details: { errors }, terminate: false };
      const after = applyReplacements(before, replacements);
      const boardErrors = checkStoryboard(after);
      if (boardErrors.length) return { content: [{ type: "text", text: `REJECTED full storyboard check failed: ${boardErrors.join("；")}` }], details: { boardErrors }, terminate: false };
      const backup = path.join(runDir, "work", "bilingual-hotfix", `ep-${ep(episode)}.before.md`);
      if (!fs.existsSync(backup)) writeText(backup, before);
      writeText(boardFile, after);
      const taskFile = taskPath(runDir, `storyboard-ep-${ep(episode)}`);
      const prior = fs.existsSync(taskFile) ? JSON.parse(readText(taskFile)) : {};
      writeJson(taskFile, { ...prior, state: "passed", digest: sha(after), bilingualHotfix: { repairedShots: expected, at: new Date().toISOString() } });
      accepted = true;
      repaired = replacements.size;
      return { content: [{ type: "text", text: `ACCEPTED ${repaired} bilingual dialogue repairs for EP${ep(episode)}` }], details: { repaired }, terminate: true };
    },
  });

  const role = `bilingual-hotfix-ep-${ep(episode)}`;
  const { session, metrics } = await createPiExperimentSession({
    runDir,
    role,
    systemPrompt: "你是双语台词修复 Writer。只修指定分镜的台词格，不改剧情、人物、镜头、动作或其他列。每个台词格必须是：角色：自然中文台词<br>EN: Natural English line<br>表演：原表演说明。英文原句已有时保留意思并补准确自然的中文；中文已有时保留意思并补准确自然的英文；顺序错误时调整顺序；禁止使用“同上”。多人同镜时每个人都要各自成对。只能通过 submit_bilingual_repairs 提交。",
    customTools: [submit],
    toolNames: ["submit_bilingual_repairs"],
  });
  const task = failures.map((row) => `### ${row.shotId}\n画面：${row.visual}\n当前台词格：${row.dialogue}\n错误：${row.errors.join("；")}`).join("\n\n");
  const screenplay = fs.existsSync(screenplayFile) ? readText(screenplayFile).slice(0, 30000) : "";
  let outcome = "completed";
  try {
    await promptWithWatchdog(session, metrics, `修复 EP${ep(episode)} 的全部 ${failures.length} 个问题镜头。提交集合必须恰好包含这些镜头，不能多也不能少。\n\n待修复镜头：\n${task}\n\n本集源剧本（只用于理解语义，禁止改剧情）：\n${screenplay}`, 600000);
    if (!accepted) throw new Error(`hotfix Writer did not submit EP${ep(episode)}`);
  } catch (error) {
    outcome = "failed";
    throw error;
  } finally {
    session.dispose();
    writeJson(path.join(runDir, "metrics", `${role}.json`), { role, outcome, endedAt: new Date().toISOString(), ...metrics });
  }
  return { episode, outcome, repaired };
}

export async function hotfixBilingualStoryboards(runDir, episodes) {
  const manifest = loadManifest(runDir);
  const selected = episodes.length ? episodes : Array.from({ length: manifest.episodes }, (_, index) => index + 1)
    .filter((episode) => fs.existsSync(path.join(runDir, "storyboard", `ep-${ep(episode)}.md`)));
  const results = [];
  for (const episode of selected) results.push(await repairEpisode(runDir, episode));
  return results;
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const runDir = path.resolve(process.argv[2] || "");
  const episodes = process.argv.slice(3).map(Number).filter(Number.isInteger);
  if (!runDir || !fs.existsSync(path.join(runDir, "manifest.json"))) throw new Error("usage: node src/bilingual-hotfix.mjs <run-dir> [episode ...]");
  console.log(JSON.stringify(await hotfixBilingualStoryboards(runDir, episodes), null, 2));
}
