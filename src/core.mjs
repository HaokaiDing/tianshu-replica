import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { dialogueCellErrors } from "./bilingual.mjs";
import { canonicalPersonNames, fixedEntityErrors } from "./entities.mjs";
import { createProductionContract, loadProductionContract, productionContractDigest, writeProductionContract } from "./production-contract.mjs";
import { parseSourceOutline } from "./replication.mjs";
import { normalizeSourceMaterials } from "./source-materials.mjs";
import { createSampleScope, sampleLabel } from "./sample.mjs";

export function renderDeliveryMarkdown(manifest, episodes) {
  const body = episodes.join("\n\n---\n\n");
  const total = manifest.scope?.sourceTotalEpisodes;
  const scopeNote = `交付范围：原剧第1–3集样例。源剧总集数：${total ?? "未知"}。其余剧集不在本次交付范围内。`;
  return sampleLabel(manifest) ? `# ${sampleLabel(manifest)}${manifest.title}\n\n${scopeNote}\n\n${body}` : body;
}

export const STORYBOARD_HEADER = ["镜头号", "画面描述", "中英双语台词", "运镜方式/景别", "人物图/场景图", "备注（音效）", "建议时长（s）"];
export const STATES = new Set(["draft", "planning", "awaiting_approval", "approved", "screenplay_producing", "screenplay_reviewing", "screenplay_repairing", "screenplay_passed", "storyboard_producing", "storyboard_reviewing", "storyboard_repairing", "final_review", "awaiting_delivery_approval", "ready_to_deliver", "delivered", "returned", "needs_human_review", "blocked", "failed"]);
export const sha = (text) => crypto.createHash("sha256").update(String(text)).digest("hex");
export function writeText(file, text) { fs.mkdirSync(path.dirname(file), { recursive: true }); const tmp=`${file}.${process.pid}.tmp`; fs.writeFileSync(tmp, `${String(text).trimEnd()}\n`); fs.renameSync(tmp,file); }
export function writeJson(file, value) { writeText(file, JSON.stringify(value, null, 2)); }
export function readJson(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }
export function readText(file) { return fs.readFileSync(file, "utf8"); }
export function runRoot(root) { return path.join(root, "runs"); }
export function manifestPath(runDir) { return path.join(runDir, "manifest.json"); }
export function taskPath(runDir, id) { return path.join(runDir, "tasks", `${id}.json`); }
export function loadManifest(runDir) { return readJson(manifestPath(runDir)); }
export function saveManifest(runDir, manifest) { manifest.updatedAt = new Date().toISOString(); writeJson(manifestPath(runDir), manifest); }
export function createRun(root, { title, episodes = 30, input, sourceOutline, sourceMaterials, sample = false, sourceTotalEpisodes = null, productionContract = createProductionContract() }) {
  if (sample ? Number(episodes) !== 3 : ![30,60].includes(Number(episodes))) throw new Error(sample ? "sample requires exactly 3 episodes" : "episodes must be 30 or 60");
  if (sourceOutline !== undefined && sourceMaterials !== undefined) throw new Error("sourceMaterials and sourceOutline cannot be supplied together");
  if (sample && sourceOutline === undefined && sourceMaterials === undefined) throw new Error("sample requires a source outline or source materials");
  const scope = sample ? createSampleScope(sourceTotalEpisodes) : { kind: "full-series" };
  const materials = sourceMaterials === undefined ? null : normalizeSourceMaterials(sourceMaterials, Number(episodes));
  if (sourceOutline !== undefined) parseSourceOutline(sourceOutline, Number(episodes));
  const slug = String(title || "untitled").replace(/[^\p{L}\p{N}]+/gu, "_").replace(/^_+|_+$/g, "").slice(0,50) || "untitled";
  const id = `${slug}-${Date.now().toString(36)}`;
  const dir = path.join(runRoot(root), id);
  for (const sub of ["canonical","screenplay","storyboard","continuity","reviews","research","work","tasks","metrics","deliverables"]) fs.mkdirSync(path.join(dir, sub), {recursive:true});
  const manifest = { id, title: title || "Untitled", episodes: Number(episodes), scope, productionRoute: sourceOutline === undefined && !materials ? "tianshu-original" : "tianshu-replication", state:"draft", revision:1, inputDigest:sha(input), createdAt:new Date().toISOString(), updatedAt:new Date().toISOString() };
  saveManifest(dir, manifest); writeText(path.join(dir,"canonical","input.md"), input);
  if (materials) {
    for (const [field, name] of [["creative", "source-creative.md"], ["characters", "source-characters.md"], ["outline", "source-outline.md"]]) {
      fs.writeFileSync(path.join(dir, "canonical", name), materials[field]);
    }
    writeJson(path.join(dir, "canonical", "source-provenance.json"), materials.provenance);
  } else if (sourceOutline !== undefined) writeText(path.join(dir,"canonical","source-outline.md"), sourceOutline);
  writeProductionContract(dir, productionContract); return {id,dir,manifest};
}
export function transition(runDir, next, note="") { const m=loadManifest(runDir); if (!STATES.has(next)) throw new Error(`unknown state ${next}`); m.state=next; if(note) m.note=note; saveManifest(runDir,m); return m; }
export function cells(line) { return line.trim().split("|").slice(1,-1).map((x)=>x.trim()); }
export function checkStoryboard(markdown, canonicalNames = [], productionContract = createProductionContract()) { const lines=markdown.split("\n").filter(Boolean); const i=lines.findIndex((l)=>l.startsWith("|") && cells(l).join("|")===STORYBOARD_HEADER.join("|")); if(i<0) return ["missing exact 7-column header"]; const rows=lines.slice(i+2).filter((l)=>l.startsWith("|")&&!/^\|\s*[-:]+/.test(l)); const errors=[...fixedEntityErrors(markdown,canonicalNames)]; const shots=productionContract.storyboard.shotCount,durations=productionContract.storyboard.shotDurationSeconds,totalRange=productionContract.storyboard.episodeDurationSeconds;let expected=1,total=0;if(rows.length<shots.min||rows.length>shots.max)errors.push(`shot count ${rows.length}`);for(const row of rows){const c=cells(row);if(c.length!==7){errors.push("row has wrong column count");continue;}const seq=Number(c[0].match(/(\d+)$/)?.[1]);if(seq!==expected)errors.push(`shot ${c[0]} expected ${expected}`);expected++;errors.push(...dialogueCellErrors(c[2],`镜头 ${c[0]}`));const d=Number(c[6].match(/\d+/)?.[0]);if(!(d>=durations.min&&d<=durations.max))errors.push(`invalid duration ${c[0]}`);total+=d;}if(!(total>=totalRange.min&&total<=totalRange.max))errors.push(`total duration ${total}`);return [...new Set(errors)]; }
export function storyboardWarnings(markdown) { const lines=markdown.split("\n").filter(Boolean); const i=lines.findIndex((l)=>l.startsWith("|") && cells(l).join("|")===STORYBOARD_HEADER.join("|")); if(i<0) return []; const rows=lines.slice(i+2).filter((l)=>l.startsWith("|")&&!/^\|\s*[-:]+/.test(l)); const warnings=[]; const fn=(r)=>(cells(r)[5]||"").match(/功能[：:]\s*([^<]+)/)?.[1]?.trim()||""; if(!rows.some((r)=>/反应|停留|情绪|落点|呼吸/.test(fn(r)))) warnings.push("全集没有反应/情绪停留镜，节拍缺乏落点"); rows.forEach((r,idx)=>{const next=rows[idx+1];if(next&&/建立/.test(fn(r))&&/对峙|冲突|升级|揭示|爆发|定罪|高潮/.test(fn(next))) warnings.push(`镜${cells(r)[0]}(建立)后直接进入"${fn(next)}"，缺定位/落点镜`);}); return [...new Set(warnings)]; }
export function markdownDelivery(runDir) { const m=loadManifest(runDir); const contract=loadProductionContract(runDir),contractDigest=productionContractDigest(contract);const all=[]; const ledgerFile=path.join(runDir,"canonical","ledger.json"),charactersFile=path.join(runDir,"canonical","characters.md");const ledgerNames=fs.existsSync(ledgerFile)?readJson(ledgerFile).names||[]:[],names=canonicalPersonNames(fs.existsSync(charactersFile)?readText(charactersFile):"",ledgerNames);for(let episode=1;episode<=m.episodes;episode++){const f=path.join(runDir,"storyboard",`ep-${String(episode).padStart(2,"0")}.md`);if(!fs.existsSync(f))throw new Error(`missing storyboard ${episode}`);const md=readText(f);const task=taskPath(runDir,`storyboard-ep-${String(episode).padStart(2,"0")}`);if(!fs.existsSync(task))throw new Error(`missing storyboard task ${episode}`);const record=readJson(task);if(record.state!=="passed")throw new Error(`storyboard task ${episode} is ${record.state}`);if(record.digest!==sha(md))throw new Error(`storyboard task ${episode} digest mismatch`);if(record.contractDigest!==contractDigest)throw new Error(`storyboard task ${episode} contract mismatch`);const source=path.join(runDir,"screenplay",`ep-${String(episode).padStart(2,"0")}.md`);if(!fs.existsSync(source)||record.sourceScreenplayDigest!==sha(readText(source)))throw new Error(`storyboard task ${episode} source screenplay mismatch`);const errors=checkStoryboard(md,names,contract);if(errors.length)throw new Error(`storyboard ${episode}: ${errors.join("; ")}`);all.push(md);}return renderDeliveryMarkdown(m,all); }
