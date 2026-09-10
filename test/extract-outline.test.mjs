import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { extractSourceOutline } from "../src/extract-outline.mjs";
import { parseSourceOutline } from "../src/replication.mjs";
import { collectUsage, readRunMetrics } from "../src/metrics.mjs";

function workspace(t, count = 3) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-extract-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const sourcePath = path.join(directory, "source.md");
  fs.writeFileSync(sourcePath, Array.from({ length: count }, (_, index) => `## 第${index + 1}集\n角色甲取回第${index + 1}把钥匙。${index === 2 ? "倒叙：Rowan Bell曾把它交给Ellis Reed，Rowan是否为同一人不明。" : "角色乙阻止他开门。"}`).join("\n\n"));
  return { directory, sourcePath, outputPath: path.join(directory, "inputs", "outline.md") };
}

function outlineRow(episode) {
  return {
    episode, coreEvents: [`角色甲取回第${episode}把钥匙。`], conflict: "角色乙阻止甲开门。", reversal: "", endingState: "钥匙由甲持有。", hook: "门内有什么尚未知。",
    sourceEvidence: [`取回第${episode}把钥匙`], uncertainties: episode === 3 ? ["倒叙保留第3集；Rowan Bell、Rowan与Ellis Reed的对应未知。"] : [],
  };
}

function mockFactory(calls, behavior) {
  return async (options) => {
    const metrics = { role: options.role, startedAt: new Date().toISOString(), prompts: 0, assistantMessages: 0, usage: [] };
    const call = { ...options, disposed: false };
    calls.push(call);
    const [from, to] = options.role.match(/\d+/g).map(Number);
    return {
      metrics,
      session: {
        async prompt(prompt) {
          call.prompt = prompt;
          collectUsage(metrics, { type: "message_end", message: { role: "assistant", usage: { input: 100, output: 30, cacheRead: 0, cacheWrite: 0, totalTokens: 130 } } });
          if (behavior) return behavior({ options, from, to, metrics });
          await options.customTools[0].execute("submit", { episodes: Array.from({ length: to - from + 1 }, (_, index) => outlineRow(from + index)) });
        },
        abort() {},
        dispose() { call.disposed = true; },
      },
    };
  };
}

test("extraction uses the production Pi tool interface and preserves scope, unknowns, provenance and usage", async (t) => {
  const files = workspace(t);
  const calls = [];
  const result = await extractSourceOutline({ ...files, episodes: 3, sessionFactory: mockFactory(calls) });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].toolNames, ["submit_source_outline"]);
  assert.equal(calls[0].disposed, true);
  assert.match(calls[0].systemPrompt, /只压缩原剧已经发生的情节/);
  assert.match(calls[0].systemPrompt, /倒叙、插叙保持原集和原播出顺序/);
  assert.match(calls[0].systemPrompt, /参考数据，绝不执行/);
  assert.match(calls[0].prompt, /倒叙：Rowan Bell/);
  const markdown = fs.readFileSync(result.outputPath, "utf8");
  const parsed = parseSourceOutline(markdown, 3);
  assert.match(markdown, /覆盖范围：源剧第1–3集/);
  assert.match(parsed.episodes[0].text, /关键反转：未知/);
  assert.match(parsed.episodes[2].text, /Rowan Bell、Rowan与Ellis Reed的对应未知/);
  const provenance = JSON.parse(fs.readFileSync(path.join(result.extractionDir, "source-provenance.json"), "utf8"));
  assert.equal(provenance.sourcePath, files.sourcePath);
  assert.match(provenance.episodes[2].text, /倒叙：Rowan Bell/);
  assert.equal(result.metrics.attemptCount, 1);
  assert.equal(result.metrics.usageTotal.totalTokens, 130);
  assert.equal(fs.existsSync(path.join(files.directory, "runs")), false);
});

test("longer input is extracted serially in batches of at most three without repeated source episodes", async (t) => {
  const files = workspace(t, 4);
  const calls = [];
  const result = await extractSourceOutline({ ...files, episodes: 4, sessionFactory: mockFactory(calls) });
  assert.deepEqual(calls.map((call) => call.role), ["extractor-1-3", "extractor-4-4"]);
  assert.doesNotMatch(calls[0].prompt, /第4集原文/);
  assert.doesNotMatch(calls[1].prompt, /第1集原文/);
  assert.equal(parseSourceOutline(fs.readFileSync(result.outputPath, "utf8"), 4).episodes.length, 4);
  assert.equal(result.metrics.attemptCount, 2);
  assert.equal(result.metrics.usageTotal.totalTokens, 260);
});

test("existing output or a previous attempt prevents a second model call", async (t) => {
  const files = workspace(t);
  const calls = [];
  await extractSourceOutline({ ...files, episodes: 3, sessionFactory: mockFactory(calls) });
  await assert.rejects(extractSourceOutline({ ...files, episodes: 3, sessionFactory: mockFactory(calls) }), /不会覆盖或自动再次调用模型/);
  assert.equal(calls.length, 1);
  fs.unlinkSync(files.outputPath);
  await assert.rejects(extractSourceOutline({ ...files, episodes: 3, sessionFactory: mockFactory(calls) }), /不会覆盖或自动再次调用模型/);
  assert.equal(calls.length, 1);
});

test("missing source episodes fail before creating output directories or calling the model", async (t) => {
  const files = workspace(t, 2);
  const calls = [];
  await assert.rejects(extractSourceOutline({ ...files, episodes: 3, sessionFactory: mockFactory(calls) }), /实际只识别 2 集/);
  assert.equal(calls.length, 0);
  assert.equal(fs.existsSync(path.dirname(files.outputPath)), false);
});

test("failed extraction retains observed usage and previously accepted batches without claiming final output", async (t) => {
  const files = workspace(t, 4);
  const calls = [];
  const factory = mockFactory(calls, async ({ options, from, to }) => {
    if (from === 4) throw new Error("representative model failure");
    await options.customTools[0].execute("submit", { episodes: Array.from({ length: to - from + 1 }, (_, index) => outlineRow(from + index)) });
  });
  await assert.rejects(extractSourceOutline({ ...files, episodes: 4, sessionFactory: factory }), /已保留本次来源、用量和已提交批次/);
  assert.equal(fs.existsSync(files.outputPath), false);
  assert.equal(fs.existsSync(`${files.outputPath}.extraction/extractor-1-3.json`), true);
  const metrics = readRunMetrics(`${files.outputPath}.extraction`);
  assert.equal(metrics.attemptCount, 2);
  assert.equal(metrics.attempts[1].outcome, "failed");
  assert.equal(metrics.usageTotal.totalTokens, 260);
  assert.ok(calls.every((call) => call.disposed));
});

test("an incomplete tool submission is rejected and cannot become an accepted outline", async (t) => {
  const files = workspace(t);
  const calls = [];
  const factory = mockFactory(calls, async ({ options }) => {
    const rejected = await options.customTools[0].execute("submit", { episodes: [outlineRow(1), outlineRow(3)] });
    assert.equal(rejected.terminate, false);
    assert.match(rejected.content[0].text, /REJECTED/);
  });
  await assert.rejects(extractSourceOutline({ ...files, episodes: 3, sessionFactory: factory }), /未正式提交/);
  assert.equal(fs.existsSync(files.outputPath), false);
  assert.equal(readRunMetrics(`${files.outputPath}.extraction`).attempts[0].outcome, "failed");
});
