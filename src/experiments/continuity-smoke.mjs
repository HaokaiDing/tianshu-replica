import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { plan, produceScripts } from "../agents.mjs";
import { loadManifest, readJson, readText, saveManifest, sha, writeJson, writeText } from "../core.mjs";

const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-continuity-smoke-"));
const runId = path.basename(runDir);
for (const sub of ["canonical", "screenplay", "storyboard", "continuity", "reviews", "research", "work", "tasks", "metrics", "deliverables"]) {
  fs.mkdirSync(path.join(runDir, sub), { recursive: true });
}
const input = `# 西雅图蓝钥匙｜2 集真实连续性小样本

目标市场：美国。
地点必须是当代 Seattle，角色使用自然的美国姓名和制度背景。
第 1 集必须让女主 Maya Brooks 从已故父亲的旧合伙人 Noah Reed 手里取得一把带编号的蓝色储物柜钥匙；只有 Maya 与 Noah 知道编号，Maya 不知道柜中内容。
第 2 集必须承接钥匙已经在 Maya 手里的事实。Maya 在危机下把钥匙交给记者 Elena Cruz，Elena 到这一刻才知道编号；Noah 不知道钥匙已经转手。
每集 60–120 秒，中英双语对白，禁止监控、DNA、警察或法庭捷径。`;
writeJson(path.join(runDir, "manifest.json"), {
  id: runId,
  title: "西雅图蓝钥匙",
  episodes: 2,
  state: "draft",
  revision: 1,
  inputDigest: sha(input),
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});
writeText(path.join(runDir, "canonical", "input.md"), input);

try {
  await plan(runDir);
  const contract = readText(path.join(runDir, "canonical", "continuity-contract.md"));
  assert.ok(contract.length >= 200, "planner did not create a continuity baseline");
  const manifest = loadManifest(runDir);
  assert.equal(manifest.state, "awaiting_approval");
  manifest.state = "approved";
  manifest.note = "automated continuity smoke approval";
  saveManifest(runDir, manifest);

  await produceScripts(runDir);
  assert.equal(loadManifest(runDir).state, "screenplay_review");
  const first = readJson(path.join(runDir, "continuity", "ep-01.json"));
  const second = readJson(path.join(runDir, "continuity", "ep-02.json"));
  const current = readJson(path.join(runDir, "continuity", "current.json"));
  assert.equal(first.status, "accepted");
  assert.equal(second.status, "accepted");
  assert.equal(second.previousSnapshotDigest, first.snapshotDigest);
  assert.equal(current.lastEpisode, 2);
  assert.ok(current.snapshot.length >= 30);
  assert.ok(fs.existsSync(path.join(runDir, first.event)));
  assert.ok(fs.existsSync(path.join(runDir, second.event)));
  assert.ok(fs.existsSync(path.join(runDir, "metrics", "continuity-ep-01.json")));
  assert.ok(fs.existsSync(path.join(runDir, "metrics", "continuity-ep-02.json")));
  const result = {
    outcome: "passed",
    episodes: 2,
    contractDigest: sha(contract),
    episode1SnapshotDigest: first.snapshotDigest,
    episode2PreviousSnapshotDigest: second.previousSnapshotDigest,
    finalSnapshotDigest: current.snapshotDigest,
    continuityEvents: [first.event, second.event],
    runDir,
    runCleaned: true,
  };
  fs.rmSync(runDir, { recursive: true, force: true });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(JSON.stringify({ outcome: "failed", error: error.message, preservedRunDir: runDir }, null, 2));
  process.exitCode = 1;
}
