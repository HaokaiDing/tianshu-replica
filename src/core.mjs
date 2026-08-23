import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const STORYBOARD_HEADER = ["镜头号", "叙事功能", "画面描述", "英中双语台词", "运镜/景别/机位", "关键道具/信息点", "连续性继承", "角色视觉提示 / 场景视觉提示", "SFX/备注", "建议时长(s)", "累计时长(s)"];
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
export function checkStoryboard(markdown) { const lines=markdown.split("\n").filter(Boolean); const i=lines.findIndex((l)=>l.startsWith("|") && cells(l).join("|")===STORYBOARD_HEADER.join("|")); if(i<0) return ["missing exact 11-column header"]; const rows=lines.slice(i+2).filter((l)=>l.startsWith("|")&&!/^\|\s*[-:]+/.test(l)); const errors=[]; let expected=1, prior=0; if(rows.length<12||rows.length>20)errors.push(`shot count ${rows.length}`); for(const row of rows){const c=cells(row);if(c.length!==11){errors.push("row has wrong column count");continue;} if(Number(c[0])!==expected)errors.push(`shot ${c[0]} expected ${expected}`);expected++;const d=Number(c[9].match(/\d+/)?.[0]);const t=Number(c[10].match(/\d+/)?.[0]);if(!(d>=3&&d<=7))errors.push(`invalid duration ${c[0]}`);if(!(t>prior))errors.push(`invalid cumulative ${c[0]}`);prior=t;}if(!(prior>=55&&prior<=95))errors.push(`total duration ${prior}`);return [...new Set(errors)]; }
export function markdownDelivery(runDir) { const m=loadManifest(runDir); const all=[]; for(let ep=1;ep<=m.episodes;ep++){const f=path.join(runDir,"storyboard",`ep-${String(ep).padStart(2,"0")}.md`);if(!fs.existsSync(f))throw new Error(`missing storyboard ${ep}`);const md=readText(f);const errors=checkStoryboard(md);if(errors.length)throw new Error(`storyboard ${ep}: ${errors.join("; ")}`);all.push(md);}return all.join("\n\n---\n\n"); }
