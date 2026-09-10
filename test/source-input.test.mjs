import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { loadSourceEpisodes } from "../src/source-input.mjs";

function sourceFile(t, name, body) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-source-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, name);
  if (body !== undefined) fs.writeFileSync(file, body);
  return file;
}

test("source reader preserves duplicate adjacent headings, original labels, aliases and flashback order", async (t) => {
  const original = "剧名：测试\n## 第1集\n\n第 1 集分镜（68s）\nEllis Reed开门。\n第 2 集分镜（62s）\nRowan拿到钥匙。\n## 第3集\n第 3 集分镜（85s）\n倒叙：Rowan Bell先前藏起钥匙。\nEP04 - 后果\n他关门。\n";
  const file = sourceFile(t, "源 剧本.md", original.replaceAll("\n", "\r\n"));
  const result = await loadSourceEpisodes(file, 3);
  assert.equal(result.sourceKind, "markdown");
  assert.equal(result.totalEpisodes, 4);
  assert.deepEqual(result.episodes.map((item) => item.episode), [1, 2, 3]);
  assert.equal(result.episodes[0].text, "## 第1集\n\n第 1 集分镜（68s）\nEllis Reed开门。");
  assert.match(result.episodes[2].text, /第3集\n第 3 集分镜（85s）\n倒叙：Rowan Bell/);
  assert.match(result.episodes[0].reference, /源 剧本\.md:2-5/);
});

test("source reader accepts EP headings and treats references in prose as body", async (t) => {
  const file = sourceFile(t, "show.txt", "EP01: 开门\n她提到第2集。\n第2集的故事还没发生。\nEpisode 02 - 后果\n他们争夺钥匙。\n**EP03**\n钥匙归还。\n");
  const result = await loadSourceEpisodes(file, 3);
  assert.equal(result.sourceKind, "text");
  assert.equal(result.totalEpisodes, 3);
  assert.match(result.episodes[0].text, /第2集的故事还没发生/);
  assert.match(result.episodes[2].text, /^\*\*EP03\*\*/);
});

test("source reader rejects missing episodes, independent duplicate bodies, and empty selected chapters", async (t) => {
  const file = sourceFile(t, "source.md", "第1集\n开门\n第3集\n倒叙");
  await assert.rejects(loadSourceEpisodes(file, 3), /实际只识别 2 集/);
  await assert.rejects(loadSourceEpisodes(file, 2), /第 2 项是第 3 集/);
  fs.writeFileSync(file, "第1集\n开门\n第1集\n另一个独立正文");
  await assert.rejects(loadSourceEpisodes(file, 2), /不重复/);
  fs.writeFileSync(file, "第1集\n\n第2集\n后果");
  await assert.rejects(loadSourceEpisodes(file, 1), /第 1 集正文为空/);
});

test("unselected trailing empty chapter does not block a complete requested prefix", async (t) => {
  const file = sourceFile(t, "short.md", "第1集\n变\n第2集\n");
  const result = await loadSourceEpisodes(file, 1);
  assert.equal(result.episodes[0].text, "第1集\n变");
  assert.equal(result.totalEpisodes, 2);
});

test("DOCX reader keeps paragraphs and table rows in document order using Python standard library", async (t) => {
  const file = sourceFile(t, "原版 分镜.docx");
  const paragraph = (text) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
  const table = `<w:tbl><w:tr><w:tc>${paragraph("ep01-s01")}</w:tc><w:tc>${paragraph("她先开门")}${paragraph("再拿钥匙")}</w:tc></w:tr><w:tr><w:tc>${paragraph("ep01-s02")}</w:tc><w:tc>${paragraph("他随后关门")}</w:tc></w:tr></w:tbl>`;
  const document = `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraph("第 1 集分镜（68s）")}${paragraph("开场")}${table}${paragraph("表后状态")}${paragraph("第 2 集分镜（62s）")}${paragraph("第二集承接")}</w:body></w:document>`;
  execFileSync(process.env.TIANSHU_PYTHON || "python3", ["-c", "import sys,zipfile\nwith zipfile.ZipFile(sys.argv[1], 'w') as z: z.writestr('word/document.xml', sys.stdin.read())", file], { input: document, encoding: "utf8" });
  const result = await loadSourceEpisodes(file, 2);
  assert.equal(result.sourceKind, "docx");
  assert.equal(result.totalEpisodes, 2);
  assert.equal(result.episodes[0].text, "第 1 集分镜（68s）\n开场\nep01-s01\t她先开门 / 再拿钥匙\nep01-s02\t他随后关门\n表后状态");
});

test("source reader rejects unsupported formats and invalid requested counts before extraction", async (t) => {
  const file = sourceFile(t, "source.pdf", "第1集\n事件");
  await assert.rejects(loadSourceEpisodes(file, 1), /\.md、\.txt 或 \.docx/);
  await assert.rejects(loadSourceEpisodes(file, 0), /正整数/);
  await assert.rejects(loadSourceEpisodes(file, 1.5), /正整数/);
});
