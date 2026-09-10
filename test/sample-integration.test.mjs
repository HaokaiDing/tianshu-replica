import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { createRun, loadManifest, saveManifest, renderDeliveryMarkdown } from "../src/core.mjs";
import { createProductionContract } from "../src/production-contract.mjs";
import { planningSystemPrompt, planningTaskPrompt } from "../src/agents.mjs";
import { planningPayload, reviewPrompt } from "../src/semantic-review.mjs";
import { inferMarketIntent } from "../src/market.mjs";
import { deliveryScope } from "../src/sample.mjs";
import { runProduction } from "../src/runtime.mjs";
import { readRunMetrics } from "../src/metrics.mjs";

const input = "目标市场：中国。仅复刻原剧前3集，保持第3集倒叙。";
const outline = "## 第1集\n修理员林榆在旧钟内发现一封没有署名的邀请函。\n## 第2集\n林榆借来钥匙打开抽屉，发现另一封相同的邀请函。\n## 第3集\n一小时前，信使将邀请函放进抽屉并锁门；邀请对象仍然未知。\n";
function temporaryRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-sample-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const sampleInput = { title: "范围验证", episodes: 3, input, sourceOutline: outline, sample: true, sourceTotalEpisodes: 50 };

test("three episodes require explicit sample scope and planning/review retain an open ending", (t) => {
  const root = temporaryRoot(t);
  assert.throws(() => createRun(root, { ...sampleInput, sample: false }), /30 or 60/);
  assert.throws(() => createRun(root, { ...sampleInput, episodes: 30 }), /exactly 3/);
  assert.throws(() => createRun(root, { ...sampleInput, sourceOutline: undefined }), /source outline/);
  const { dir, manifest } = createRun(root, sampleInput);
  assert.equal(manifest.state, "draft");
  assert.deepEqual(manifest.scope, { kind: "sample", sourceEpisodeRange: [1, 3], sourceTotalEpisodes: 50 });
  const usage = readRunMetrics(dir);
  assert.equal(usage.episodes, 3);
  assert.equal(usage.isFullSeries, false);
  assert.equal(usage.scope.sourceTotalEpisodes, 50);
  for (const text of [planningSystemPrompt(manifest), planningTaskPrompt(dir, createProductionContract(), inferMarketIntent(input)), planningPayload(dir), reviewPrompt("planning", "合同", manifest), reviewPrompt("screenplay", "合同", manifest)]) {
    assert.match(text, /不得为了让小样闭环而虚构大结局/);
    assert.match(text, /倒叙承接/);
  }
  assert.doesNotMatch(reviewPrompt("planning", "合同", manifest), /全季升级线/);
});

test("sample keeps the approval gate and all production stages while reporting only three episodes", async (t) => {
  const { dir } = createRun(temporaryRoot(t), sampleInput);
  const setState = (state) => { const m = loadManifest(dir); m.state = state; saveManifest(dir, m); };
  setState("awaiting_approval");
  await assert.rejects(() => runProduction(dir), /awaiting_approval/);
  assert.equal(loadManifest(dir).state, "awaiting_approval");
  const seen = [];
  const step = (name, state) => { const m = loadManifest(dir); assert.equal(m.episodes, 3); assert.equal(m.scope.kind, "sample"); seen.push(name); if (state) setState(state); };
  setState("approved");
  const result = await runProduction(dir, {
    async produceScripts() { step("writer", "screenplay_reviewing"); },
    async reviewScripts() { step("screenplay-review", "screenplay_passed"); return { plan: { action: "pass" } }; },
    async produceStoryboards() { step("storyboard", "storyboard_reviewing"); },
    async reviewStoryboards() { step("storyboard-review", "final_review"); return { plan: { action: "pass" } }; },
    deliveryGate() { step("delivery-gate"); return deliveryScope(loadManifest(dir)); },
  });
  assert.deepEqual(seen, ["writer", "screenplay-review", "storyboard", "storyboard-review", "delivery-gate"]);
  assert.equal(result.state, "ready_to_deliver");
  assert.equal(deliveryScope(result).isFullSeries, false);
  assert.equal(deliveryScope(result).episodes, 3);
  const markdown = renderDeliveryMarkdown(result, ["第1集测试内容", "第2集测试内容", "第3集测试内容"]);
  assert.match(markdown, /^# 【原剧第1–3集样例】/);
  assert.match(markdown, /交付范围：原剧第1–3集样例/);
  assert.match(markdown, /源剧总集数：50/);
  assert.ok(markdown.endsWith("第3集测试内容"));
});

test("CLI preview reads text without creating extraction output or making a model call", (t) => {
  const root = temporaryRoot(t), source = path.join(root, "source.md"), output = path.join(root, "outline.md");
  fs.writeFileSync(source, outline);
  const cli = fileURLToPath(new URL("../bin/tianshu.mjs", import.meta.url));
  const preview = JSON.parse(execFileSync(process.execPath, [cli, "extract-outline", source, "--episodes", "3", "--output", output, "--preview"], { encoding: "utf8", timeout: 30_000 }));
  assert.equal(preview.totalEpisodes, 3);
  assert.equal(preview.selectedEpisodes.length, 3);
  assert.equal(preview.modelRequestSent, false);
  assert.equal(fs.existsSync(output), false);
  assert.equal(fs.existsSync(`${output}.extraction`), false);
});
