import fs from "node:fs";
import path from "node:path";
import { ROOT, Type, createExperimentRun, createPiExperimentSession, defineTool, finishRun, promptWithWatchdog, readJson, readText, sha, writeJson, writeText } from "./lib.mjs";

const HEADER = ["镜头号", "叙事功能", "画面描述", "英中双语台词", "运镜/景别/机位", "关键道具/信息点", "连续性继承", "角色视觉提示 / 场景视觉提示", "SFX/备注", "建议时长(s)", "累计时长(s)"];
const arg = process.argv.slice(2);
const value = (name) => arg.includes(name) ? arg[arg.indexOf(name) + 1] : null;
const stage = value("--stage") || "agent";
const suppliedRun = value("--run");

function cells(line) { return line.trim().split("|").slice(1, -1).map((cell) => cell.trim()); }
function validate(markdown) {
  const lines = markdown.split("\n").filter(Boolean);
  const header = lines.findIndex((line) => line.startsWith("|") && cells(line).join("|") === HEADER.join("|"));
  if (header < 0) return ["missing exact fixed 11-column header"];
  const rows = lines.slice(header + 2).filter((line) => /^\|/.test(line) && !/^\|\s*[-:]+/.test(line));
  const errors = [];
  if (rows.length < 12 || rows.length > 18) errors.push(`shot count ${rows.length} not in 12-18`);
  let expected = 1, prior = 0;
  for (const row of rows) {
    const rowCells = cells(row);
    if (rowCells.length !== 11) { errors.push("row does not have 11 cells"); continue; }
    if (Number(rowCells[0]) !== expected) errors.push(`shot number ${rowCells[0]} expected ${expected}`);
    expected += 1;
    const duration = Number(rowCells[9].match(/\d+/)?.[0]);
    const total = Number(rowCells[10].match(/\d+/)?.[0]);
    if (!(duration >= 3 && duration <= 7)) errors.push(`invalid duration at shot ${rowCells[0]}`);
    if (!(total > prior)) errors.push(`invalid cumulative time at shot ${rowCells[0]}`);
    prior = total;
  }
  if (!(prior >= 55 && prior <= 95)) errors.push(`total duration ${prior} not in 55-95`);
  return [...new Set(errors)];
}

if (stage === "agent") {
  const fixture = readJson(path.join(ROOT, "fixtures", "e4-storyboard.json"));
  const { id, runDir } = createExperimentRun("e4-storyboard", fixture);
  const taskDir = path.join(runDir, "work", "storyboard-ep-01");
  writeText(path.join(runDir, "screenplay", "ep-01.md"), fixture.screenplay);
  let submitted = false;
  const writeDraft = defineTool({ name: "write_draft", label: "Write storyboard draft", description: "Write the storyboard Markdown only in the task scratch workspace.", parameters: Type.Object({ markdown: Type.String({ minLength: 500 }) }), async execute(_id, params) { writeText(path.join(taskDir, "draft.md"), params.markdown); return { content: [{ type: "text", text: "draft saved" }], details: {} }; } });
  const runChecks = defineTool({ name: "run_checks", label: "Check storyboard", description: "Run the exact 11-column, shot count, and timing checks on the scratch draft.", parameters: Type.Object({}), async execute() { const errors = validate(readText(path.join(taskDir, "draft.md"))); writeJson(path.join(taskDir, "check-report.json"), { errors }); return { content: [{ type: "text", text: errors.length ? `FAIL: ${errors.join("; ")}` : "PASS" }], details: { errors } }; } });
  const submitStoryboard = defineTool({ name: "submit_storyboard", label: "Submit storyboard", description: "Promote only a passing 11-column scratch draft to canonical ep01 storyboard.", parameters: Type.Object({}), async execute() { const report = readJson(path.join(taskDir, "check-report.json")); if (report.errors.length) return { content: [{ type: "text", text: `REJECTED: ${report.errors.join("; ")}` }], details: report, terminate: false }; const draft = readText(path.join(taskDir, "draft.md")); writeText(path.join(runDir, "storyboard", "ep-01.md"), draft); submitted = true; return { content: [{ type: "text", text: "ACCEPTED storyboard ep01" }], details: {}, terminate: true }; } });
  const systemPrompt = `You are a storyboard director. Work in scratch: write_draft, run_checks, submit_storyboard. Use this exact header and no other columns: | ${HEADER.join(" | ")} |. Generate 12-18 shots, each 3-7 seconds, total 55-95 seconds. Do not use pipe characters inside cell content. Preserve the screenplay hook and continuity. Do not answer in prose.`;
  const { session, metrics } = await createPiExperimentSession({ runDir, role: "e4-storyboard", systemPrompt, customTools: [writeDraft, runChecks, submitStoryboard], toolNames: ["write_draft", "run_checks", "submit_storyboard"] });
  try {
    await promptWithWatchdog(session, metrics, `Storyboard this screenplay:\n${fixture.screenplay}`);
    if (!submitted) throw new Error("storyboard agent did not submit");
    const markdown = readText(path.join(runDir, "storyboard", "ep-01.md"));
    finishRun(runDir, { outcome: "agent_passed", metrics, markdownDigest: sha(markdown), next: `npm run experiment:e4:render -- --run ${runDir}` });
    console.log(JSON.stringify({ id, runDir, outcome: "agent_passed" }, null, 2));
  } catch (error) {
    finishRun(runDir, { outcome: "failed", metrics, error: String(error?.message || error) });
    throw error;
  } finally { session.dispose(); }
} else if (stage === "render") {
  if (!suppliedRun) throw new Error("--run <experiment run directory> is required for render stage");
  const input = path.join(suppliedRun, "storyboard", "ep-01.md");
  if (!fs.existsSync(input)) throw new Error(`missing storyboard: ${input}`);
  const output = path.join(suppliedRun, "deliverables", "The Glass Orchid Contract（玻璃兰契约）｜分镜剧本.docx");
  const { execFileSync } = await import("node:child_process");
  fs.mkdirSync(path.dirname(output), { recursive: true });
  execFileSync(process.env.TIANSHU_PYTHON || "python3", [path.join(ROOT, "src", "experiments", "render_storyboard_docx.py"), input, output]);
  const manifest = readJson(path.join(suppliedRun, "manifest.json"));
  manifest.state = "docx_rendered";
  manifest.docx = { inputDigest: sha(readText(input)), output, renderedAt: new Date().toISOString() };
  writeJson(path.join(suppliedRun, "manifest.json"), manifest);
  console.log(JSON.stringify({ runDir: suppliedRun, input, output }, null, 2));
} else throw new Error(`unknown --stage ${stage}`);
