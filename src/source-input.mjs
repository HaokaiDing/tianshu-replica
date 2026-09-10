import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const executeFile = promisify(execFile);
const docxReader = fileURLToPath(new URL("../scripts/read-source-docx.py", import.meta.url));

function episodeHeading(line) {
  const text = line.trim().replace(/^#{1,6}\s*/, "").replace(/^(?:\*\*|__)(.*?)(?:\*\*|__)$/, "$1");
  if (/^EP\d+-s\d+\b/i.test(text)) return null;
  const match = text.match(/^(?:第\s*(\d+)\s*集(?:分镜(?:剧本)?|剧本)?|EP(?:ISODE)?\s*(\d+))(?=$|[\s:：【\[（(—–-])/i);
  return match ? Number(match[1] ?? match[2]) : null;
}

export async function loadSourceEpisodes(file, count) {
  if (!Number.isInteger(count) || count < 1) throw new Error("提取集数必须为正整数");
  const sourcePath = path.resolve(file);
  const extension = path.extname(sourcePath).toLowerCase();
  const sourceKind = extension === ".docx" ? "docx" : extension === ".md" ? "markdown" : extension === ".txt" ? "text" : null;
  if (!sourceKind) throw new Error("源文件必须是 .md、.txt 或 .docx");
  const raw = sourceKind === "docx"
    ? (await executeFile(process.env.TIANSHU_PYTHON || "python3", [docxReader, sourcePath], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 })).stdout
    : await fs.readFile(sourcePath, "utf8");
  const lines = raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n");
  const headings = [];
  for (let index = 0; index < lines.length; index++) {
    const episode = episodeHeading(lines[index]);
    if (episode === null) continue;
    const previous = headings.at(-1);
    // Exported Markdown may add a heading immediately before the original DOCX
    // heading. Keep both source lines, but count this one section only once.
    if (previous?.episode === episode && !lines.slice(previous.bodyStart, index).join("\n").trim()) {
      previous.bodyStart = index + 1;
      continue;
    }
    headings.push({ episode, start: index, bodyStart: index + 1 });
  }
  if (headings.length < count) throw new Error(`需要源剧前 ${count} 集，实际只识别 ${headings.length} 集`);
  const episodes = headings.slice(0, count).map((heading, index) => {
    if (heading.episode !== index + 1) throw new Error(`源剧前 ${count} 集必须从 1 连续有序且不重复：第 ${index + 1} 项是第 ${heading.episode} 集`);
    const end = headings[index + 1]?.start ?? lines.length;
    if (!lines.slice(heading.bodyStart, end).join("\n").trim()) throw new Error(`源剧第 ${heading.episode} 集正文为空`);
    return {
      episode: heading.episode,
      text: lines.slice(heading.start, end).join("\n").trim(),
      reference: `${path.basename(sourcePath)}:${heading.start + 1}-${end}（${lines[heading.start].trim()}）`,
    };
  });
  return { sourcePath, sourceKind, totalEpisodes: headings.length, episodes };
}
