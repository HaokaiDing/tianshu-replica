import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { commitContinuityReview, continuityContext, continuityIsAccepted, extractContinuityUpdate, stageContinuityProposal } from "../src/continuity.mjs";
import { createRun, readJson, sha, writeText } from "../src/core.mjs";

function screenplay(episode, update) {
  return `# 第${episode}集｜EP${String(episode).padStart(2, "0")}\n\n## 场景一\n\nMAYA（中）：钥匙在我这里。\nMAYA（EN）：I have the key.\n\n## 【本集钩子】\n门被打开。\n\n## 【连续性检查】\n${update}`;
}

test("continuity update is extracted from the screenplay", () => {
  assert.equal(extractContinuityUpdate(screenplay(1, "钥匙由 Maya 保管。")), "钥匙由 Maya 保管。");
});

test("continuity history is append-only and each episode chains from the prior snapshot", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-continuity-test-"));
  try {
    const { dir } = createRun(root, { title: "连续性测试", episodes: 30, input: "x" });
    const contractFile = path.join(dir, "canonical", "continuity-contract.md");
    writeText(contractFile, "Maya 身份固定。开篇钥匙在前台保险柜，任何转移必须在剧本中发生。");
    const contractDigest = sha(fs.readFileSync(contractFile, "utf8"));
    const first = screenplay(1, "Maya 从保险柜领取钥匙；只有 Maya 知道钥匙编号。");
    stageContinuityProposal(dir, { episode: 1, screenplay: first, proposedUpdate: "Maya 已领取钥匙。" });
    const rejected = commitContinuityReview(dir, {
      episode: 1,
      screenplay: first,
      proposedUpdate: "所有人都知道钥匙编号。",
      review: { verdict: "reject", approvedUpdate: "不适用", currentSnapshot: "不适用", reason: "剧本只支持 Maya 知道。" },
    });
    assert.equal(rejected.accepted, false);
    const accepted = commitContinuityReview(dir, {
      episode: 1,
      screenplay: first,
      proposedUpdate: "Maya 已领取钥匙。",
      review: { verdict: "correct", approvedUpdate: "Maya 从保险柜领取钥匙；只有 Maya 知道编号。", currentSnapshot: "客观事实：钥匙现在由 Maya 保管。人物认知：只有 Maya 知道钥匙编号。未解决：钥匙对应哪扇门尚未揭示。", reason: "补充人物认知边界。" },
    });
    assert.equal(accepted.accepted, true);
    assert.equal(continuityIsAccepted(dir, 1, sha(first)), true);
    assert.equal(fs.readdirSync(path.join(dir, "continuity", "events", "ep-01")).length, 2);
    assert.equal(sha(fs.readFileSync(contractFile, "utf8")), contractDigest);

    const beforeSecond = continuityContext(dir).current.snapshotDigest;
    const second = screenplay(2, "Maya 把钥匙交给 Noah；Noah 此时才知道编号。");
    stageContinuityProposal(dir, { episode: 2, screenplay: second, proposedUpdate: "钥匙转交 Noah。" });
    commitContinuityReview(dir, {
      episode: 2,
      screenplay: second,
      proposedUpdate: "钥匙转交 Noah。",
      review: { verdict: "accept", approvedUpdate: "Maya 把钥匙交给 Noah；Noah 知道编号。", currentSnapshot: "客观事实：钥匙现在由 Noah 保管。人物认知：Maya 与 Noah 知道钥匙编号。未解决：钥匙对应哪扇门尚未揭示。", reason: "提案与剧本和上一集状态一致。" },
    });
    const secondRecord = readJson(path.join(dir, "continuity", "ep-02.json"));
    assert.equal(secondRecord.previousSnapshotDigest, beforeSecond);
    assert.equal(readJson(path.join(dir, "continuity", "current.json")).lastEpisode, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
