import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseSourceOutline, readReplicationSource, replicationPlannerContext, replicationReviewContext } from "../src/replication.mjs";

const sample = "剧名：旧店新灯\n\n## 第1集：停电\n林夏抢救了冰柜，发现电表被锁。\n\n第2集【钥匙】\n她拿回钥匙，店门却已被贴上转租广告。\n\n### 第 3 集\n她撕下广告，向街坊公开招募合伙人。\n";

function makeRun(t, manifest) {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-replication-"));
  t.after(() => fs.rmSync(runDir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(runDir, "canonical"));
  fs.writeFileSync(path.join(runDir, "manifest.json"), JSON.stringify(manifest));
  return runDir;
}

test("source outline accepts Markdown and plain headings while retaining the original episode text", () => {
  const parsed = parseSourceOutline(sample.replaceAll("\n", "\r\n"), 3);
  assert.equal(parsed.preamble, "剧名：旧店新灯");
  assert.deepEqual(parsed.episodes.map((item) => item.episode), [1, 2, 3]);
  assert.equal(parsed.episodes[1].text, "第2集【钥匙】\n她拿回钥匙，店门却已被贴上转租广告。");
  assert.match(parsed.episodes[2].text, /公开招募合伙人/);
});

test("source outline rejects missing, extra, repeated, and reordered episodes", () => {
  assert.throws(() => parseSourceOutline(sample, 4), /实际识别 3 集/);
  assert.throws(() => parseSourceOutline(sample, 2), /实际识别 3 集/);
  assert.throws(() => parseSourceOutline(sample.replace("第2集", "第1集"), 3), /不重复/);
  assert.throws(() => parseSourceOutline("第2集\n后果\n第1集\n起因", 2), /连续有序/);
  assert.throws(() => parseSourceOutline("第0集\n起因", 1), /第 0 集/);
});

test("source outline checks nonempty bodies without imposing length or content-quality requirements", () => {
  assert.throws(() => parseSourceOutline("## 第1集 标题\n\n第2集\n后果", 2), /第 1 集正文为空/);
  assert.throws(() => parseSourceOutline("没有分集标题", 1), /实际识别 0 集/);
  assert.deepEqual(parseSourceOutline("第1集\n变", 1).episodes, [{ episode: 1, text: "第1集\n变" }]);
});

test("episode references within body text do not become headings", () => {
  const source = "第1集\n她提到第2集的往事。\n第2集的故事仍未发生。";
  assert.equal(parseSourceOutline(source, 1).episodes.length, 1);
});

test("original routes do not load or require a replication source", (t) => {
  for (const productionRoute of [undefined, "tianshu-original"]) {
    const runDir = makeRun(t, { episodes: 3, productionRoute });
    assert.equal(readReplicationSource(runDir), null);
    assert.equal(replicationPlannerContext(runDir), "");
    assert.equal(replicationReviewContext(runDir), "");
  }
});

test("replication source and both agent contexts preserve the source and declared boundaries", (t) => {
  const runDir = makeRun(t, { episodes: 3, productionRoute: "tianshu-replication" });
  fs.writeFileSync(path.join(runDir, "canonical", "source-outline.md"), sample);
  assert.equal(readReplicationSource(runDir).markdown, sample);
  assert.equal(readReplicationSource(runDir).episodes.length, 3);
  for (const context of [replicationPlannerContext(runDir), replicationReviewContext(runDir)]) {
    assert.ok(context.includes(sample));
    assert.match(context, /因果顺序.*主冲突.*关键反转.*结尾状态与集尾钩子/);
    assert.match(context, /对白、动作和场景细节/);
    assert.match(context, /适配后的名称全剧一致/);
    assert.match(context, /参考数据.*均不执行/);
  }
  assert.match(replicationPlannerContext(runDir), /禁止自由重构情节/);
  assert.match(replicationReviewContext(runDir), /现有 findings、证据和修订流程/);
});

test("replication route fails before planning when its required source is missing or incomplete", (t) => {
  const runDir = makeRun(t, { episodes: 3, productionRoute: "tianshu-replication" });
  assert.throws(() => readReplicationSource(runDir), /ENOENT/);
  fs.writeFileSync(path.join(runDir, "canonical", "source-outline.md"), "第1集\n开店");
  assert.throws(() => replicationPlannerContext(runDir), /实际识别 1 集/);
});

test("synthetic example covers thirty ordered episodes with distinct material", () => {
  const markdown = fs.readFileSync(new URL("../fixtures/replication-example.md", import.meta.url), "utf8");
  const parsed = parseSourceOutline(markdown, 30);
  assert.match(parsed.preamble, /合成示例/);
  assert.equal(parsed.episodes.length, 30);
  assert.match(parsed.episodes[0].text, /停电/);
  assert.match(parsed.episodes[29].text, /重新开门/);
});
