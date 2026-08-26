import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const STORYBOARD_HEADER = ["镜头号", "画面描述", "中英双语台词", "运镜方式/景别", "人物图/场景图", "备注（音效）", "建议时长（s）"];
export const STATES = new Set(["draft", "planning", "awaiting_approval", "approved", "screenplay_producing", "screenplay_review", "storyboard_producing", "final_review", "awaiting_delivery_approval", "ready_to_deliver", "delivered", "returned", "blocked", "failed"]);
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
export function createRun(root, { title, episodes = 30, input }) {
  if (![30,60].includes(Number(episodes))) throw new Error("episodes must be 30 or 60");
  const slug = String(title || "untitled").replace(/[^\p{L}\p{N}]+/gu, "_").replace(/^_+|_+$/g, "").slice(0,50) || "untitled";
  const id = `${slug}-${Date.now().toString(36)}`;
  const dir = path.join(runRoot(root), id);
  for (const sub of ["canonical","screenplay","storyboard","continuity","reviews","research","work","tasks","metrics","deliverables"]) fs.mkdirSync(path.join(dir, sub), {recursive:true});
  const manifest = { id, title: title || "Untitled", episodes: Number(episodes), state:"draft", revision:1, inputDigest:sha(input), createdAt:new Date().toISOString(), updatedAt:new Date().toISOString() };
  saveManifest(dir, manifest); writeText(path.join(dir,"canonical","input.md"), input); return {id,dir,manifest};
}
export function transition(runDir, next, note="") { const m=loadManifest(runDir); if (!STATES.has(next)) throw new Error(`unknown state ${next}`); m.state=next; if(note) m.note=note; saveManifest(runDir,m); return m; }
export function cells(line) { return line.trim().split("|").slice(1,-1).map((x)=>x.trim()); }
export function checkStoryboard(markdown) { const lines=markdown.split("\n").filter(Boolean); const i=lines.findIndex((l)=>l.startsWith("|") && cells(l).join("|")===STORYBOARD_HEADER.join("|")); if(i<0) return ["missing exact 7-column header"]; const rows=lines.slice(i+2).filter((l)=>l.startsWith("|")&&!/^\|\s*[-:]+/.test(l)); const errors=[]; let expected=1, total=0; if(rows.length<12||rows.length>24)errors.push(`shot count ${rows.length}`); for(const row of rows){const c=cells(row);if(c.length!==7){errors.push("row has wrong column count");continue;} const seq=Number(c[0].match(/(\d+)$/)?.[1]);if(seq!==expected)errors.push(`shot ${c[0]} expected ${expected}`);expected++;const d=Number(c[6].match(/\d+/)?.[0]);if(!(d>=3&&d<=10))errors.push(`invalid duration ${c[0]}`);total+=d;}if(!(total>=60&&total<=120))errors.push(`total duration ${total}`);return [...new Set(errors)]; }
export function storyboardWarnings(markdown) { const lines=markdown.split("\n").filter(Boolean); const i=lines.findIndex((l)=>l.startsWith("|") && cells(l).join("|")===STORYBOARD_HEADER.join("|")); if(i<0) return []; const rows=lines.slice(i+2).filter((l)=>l.startsWith("|")&&!/^\|\s*[-:]+/.test(l)); const warnings=[]; const fn=(r)=>(cells(r)[5]||"").match(/功能[：:]\s*([^<]+)/)?.[1]?.trim()||""; if(!rows.some((r)=>/反应|停留|情绪|落点|呼吸/.test(fn(r)))) warnings.push("全集没有反应/情绪停留镜，节拍缺乏落点"); rows.forEach((r,idx)=>{const next=rows[idx+1];if(next&&/建立/.test(fn(r))&&/对峙|冲突|升级|揭示|爆发|定罪|高潮/.test(fn(next))) warnings.push(`镜${cells(r)[0]}(建立)后直接进入"${fn(next)}"，缺定位/落点镜`);}); return [...new Set(warnings)]; }
export function markdownDelivery(runDir) { const m=loadManifest(runDir); const all=[]; for(let ep=1;ep<=m.episodes;ep++){const f=path.join(runDir,"storyboard",`ep-${String(ep).padStart(2,"0")}.md`);if(!fs.existsSync(f))throw new Error(`missing storyboard ${ep}`);const md=readText(f);const errors=checkStoryboard(md);if(errors.length)throw new Error(`storyboard ${ep}: ${errors.join("; ")}`);all.push(md);}return all.join("\n\n---\n\n"); }
