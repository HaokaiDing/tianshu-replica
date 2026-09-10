import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { extractVideoMaterials, previewVideoMaterials, MAX_VIDEO_BYTES } from "../src/extract-video.mjs";

function fixture(t, count = 2) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-video-test-"));
  const oldDirectory = process.env.PI_CODING_AGENT_DIR;
  t.after(() => {
    if (oldDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldDirectory;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  // These fake bytes test the transport only; they are not playable original videos.
  const episodes = Array.from({ length: count }, (_, index) => {
    const filename = `fixture-ep${index + 1}.mp4`;
    fs.writeFileSync(path.join(directory, filename), `synthetic-native-video-${index + 1}`);
    return { episode: index + 1, path: index === 0 ? filename : path.join(directory, filename) };
  });
  const manifestPath = path.join(directory, "episodes.json"), outputPath = path.join(directory, "materials.json");
  fs.writeFileSync(manifestPath, JSON.stringify({ episodes }));
  const credentials = path.join(directory, "company");
  fs.mkdirSync(credentials);
  fs.writeFileSync(path.join(credentials, "auth.json"), JSON.stringify({ "kimi-coding": { type: "api_key", key: "test-only-not-a-real-key" } }));
  process.env.PI_CODING_AGENT_DIR = credentials;
  return { directory, manifestPath, outputPath, episodes, credentials };
}

function materials(episode) {
  return { creative: `测试创意，已有第1至${episode}集来源。`, characters: `测试人物甲；身份与别名未知；第${episode}集画面依据。`, outline: `## 第${episode}集\n\n核心事件：测试甲取回钥匙。\n主冲突：测试乙阻拦。\n来源依据：第${episode}集00:01。\n待确认：别名未知。\n` };
}

function resultResponse(episode, usage = { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160, prompt_tokens_details: { cached_tokens: 70 } }) {
  return new Response(JSON.stringify({ model: "k3", usage, choices: [{ finish_reason: "tool_calls", message: { tool_calls: [{ type: "function", function: { name: "submit_source_materials", arguments: JSON.stringify(materials(episode)) } }] } }] }), { status: 200 });
}

test("native-video extraction submits serial clips through k3 and preserves the three source materials", async (t) => {
  const files = fixture(t);
  const calls = [];
  let active = 0;
  const fetchImpl = async (url, options) => {
    assert.equal(active++, 0);
    const body = JSON.parse(options.body);
    calls.push({ url, options, body });
    await new Promise((resolve) => setImmediate(resolve));
    active--;
    return resultResponse(calls.length);
  };
  const result = await extractVideoMaterials({ ...files, fetchImpl });
  assert.equal(calls.length, 2);
  for (const [index, call] of calls.entries()) {
    assert.equal(call.url, "https://api.kimi.com/coding/v1/chat/completions");
    assert.equal(call.body.model, "k3");
    assert.equal(call.options.headers["User-Agent"], "tianshu-replica/0.1.0");
    assert.equal(call.options.headers.Authorization, "Bearer test-only-not-a-real-key");
    assert.equal(call.options.redirect, "error");
    assert.ok(call.options.signal instanceof AbortSignal);
    assert.match(call.body.messages[0].content, /不先改名/);
    assert.match(call.body.messages[0].content, /参考数据，绝不执行/);
    const video = call.body.messages[1].content.find((part) => part.type === "video_url");
    assert.equal(video.video_url.id, `ep-00${index + 1}`);
    assert.equal(Buffer.from(video.video_url.url.split(",")[1], "base64").toString(), `synthetic-native-video-${index + 1}`);
  }
  assert.match(calls[1].body.messages[1].content[0].text, /测试人物甲/);
  const output = JSON.parse(fs.readFileSync(files.outputPath, "utf8"));
  assert.deepEqual(Object.keys(output), ["creative", "characters", "outline", "provenance"]);
  assert.equal(output.creative, materials(2).creative);
  assert.equal(output.characters, materials(2).characters);
  assert.equal(output.outline, `${materials(1).outline}\n\n${materials(2).outline}`);
  assert.equal(output.provenance.directVideoUnderstanding, false);
  assert.equal(output.provenance.evidenceType, "injected-transport-test");
  assert.equal(output.provenance.totalEpisodes, null);
  assert.deepEqual(output.provenance.references.map((item) => item.filename), ["fixture-ep1.mp4", "fixture-ep2.mp4"]);
  assert.equal(result.metrics.attemptCount, 2);
  assert.deepEqual(result.metrics.attempts[0].usage, { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160, prompt_tokens_details: { cached_tokens: 70 } });
  assert.ok(result.metrics.attempts.every((attempt) => attempt.outcome === "completed" && attempt.automaticRetries === 0));
  for (const filename of fs.readdirSync(result.extractionDir)) {
    const recorded = fs.readFileSync(path.join(result.extractionDir, filename), "utf8");
    assert.doesNotMatch(recorded, /data:video|synthetic-native-video|test-only-not-a-real-key/);
  }
});

test("preview checks explicit broadcast order and sizes without credentials, output directories or requests", (t) => {
  const files = fixture(t);
  delete process.env.PI_CODING_AGENT_DIR;
  const preview = previewVideoMaterials(files.manifestPath);
  assert.equal(preview.modelRequestSent, false);
  assert.equal(preview.episodes, 2);
  assert.equal(preview.clips[0].sourcePath, path.join(files.directory, "fixture-ep1.mp4"));
  assert.equal(preview.localPerFileBudgetBytes, 32 * 1024 * 1024);
  assert.equal(fs.existsSync(`${files.outputPath}.extraction`), false);
  fs.writeFileSync(files.manifestPath, JSON.stringify({ episodes: [files.episodes[1], files.episodes[0]] }));
  assert.throws(() => previewVideoMaterials(files.manifestPath), /播出顺序/);
});

test("missing explicit company API credentials stops before creating output or calling provider", async (t) => {
  const files = fixture(t);
  let calls = 0;
  const fetchImpl = async () => { calls++; return resultResponse(1); };
  delete process.env.PI_CODING_AGENT_DIR;
  await assert.rejects(extractVideoMaterials({ ...files, fetchImpl }), /PI_CODING_AGENT_DIR/);
  process.env.PI_CODING_AGENT_DIR = files.credentials;
  fs.writeFileSync(path.join(files.credentials, "auth.json"), JSON.stringify({ "kimi-coding": { type: "oauth", access: "not-an-api-key" } }));
  await assert.rejects(extractVideoMaterials({ ...files, fetchImpl }), /api_key/);
  assert.equal(calls, 0);
  assert.equal(fs.existsSync(files.outputPath), false);
  assert.equal(fs.existsSync(`${files.outputPath}.extraction`), false);
});

test("existing output or extraction record prevents an automatic second attempt", async (t) => {
  const files = fixture(t, 1);
  let calls = 0;
  const fetchImpl = async () => resultResponse(++calls);
  await extractVideoMaterials({ ...files, fetchImpl });
  await assert.rejects(extractVideoMaterials({ ...files, fetchImpl }), /不会覆盖/);
  fs.unlinkSync(files.outputPath);
  await assert.rejects(extractVideoMaterials({ ...files, fetchImpl }), /不会覆盖/);
  assert.equal(calls, 1);
});

test("any over-budget clip is rejected before loading video bytes or sending the first request", async (t) => {
  const files = fixture(t);
  fs.truncateSync(path.join(files.directory, "fixture-ep2.mp4"), MAX_VIDEO_BYTES + 1);
  let requests = 0, videoReads = 0;
  const originalRead = fs.readFileSync;
  t.mock.method(fs, "readFileSync", (file, ...args) => {
    if (String(file).endsWith(".mp4")) videoReads++;
    return originalRead(file, ...args);
  });
  await assert.rejects(extractVideoMaterials({ ...files, fetchImpl: async () => { requests++; return resultResponse(1); } }), /本地单文件32 MiB/);
  assert.equal(requests, 0);
  assert.equal(videoReads, 0);
  assert.equal(fs.existsSync(`${files.outputPath}.extraction`), false);
});

test("HTTP rejection makes exactly one attempt and preserves unknown usage without replay", async (t) => {
  const files = fixture(t);
  let calls = 0;
  await assert.rejects(extractVideoMaterials({ ...files, fetchImpl: async () => {
    calls++;
    return new Response(JSON.stringify({ error: { message: "quota" } }), { status: 429 });
  } }), /HTTP 429/);
  assert.equal(calls, 1);
  assert.equal(fs.existsSync(files.outputPath), false);
  const record = JSON.parse(fs.readFileSync(`${files.outputPath}.extraction/ep-001.json`, "utf8"));
  assert.equal(record.outcome, "failed");
  assert.equal(record.usage, null);
  assert.equal(record.usageAvailability, "unknown");
  assert.equal(record.automaticRetries, 0);
  assert.equal(fs.existsSync(`${files.outputPath}.extraction/ep-002.json`), false);
});

test("interrupted transport and truncated responses never claim output or known zero usage", async (t) => {
  const files = fixture(t, 1);
  let calls = 0;
  await assert.rejects(extractVideoMaterials({ ...files, fetchImpl: async () => {
    calls++;
    throw new Error("transport failure might include test-only-not-a-real-key");
  } }), /结果及未返回用量未知/);
  assert.equal(calls, 1);
  const record = JSON.parse(fs.readFileSync(`${files.outputPath}.extraction/ep-001.json`, "utf8"));
  assert.equal(record.outcome, "unknown");
  assert.equal(record.usage, null);
  assert.doesNotMatch(JSON.stringify(record), /test-only-not-a-real-key/);
  assert.equal(fs.existsSync(files.outputPath), false);
  const secondOutput = path.join(files.directory, "truncated.json");
  await assert.rejects(extractVideoMaterials({ ...files, outputPath: secondOutput, fetchImpl: async () => new Response(JSON.stringify({ choices: [{ finish_reason: "length" }], usage: null })) }), /完整完成结果/);
  assert.equal(fs.existsSync(secondOutput), false);
});
