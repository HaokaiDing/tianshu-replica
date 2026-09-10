import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendRunMetrics, collectUsage, readRunMetrics, summarizePromptRequests, summarizeUsage } from "../src/metrics.mjs";
import { promptWithWatchdog } from "../src/experiments/lib.mjs";

const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
const event = (usage) => ({ type: "message_end", message: { role: "assistant", usage } });
function temporaryRun(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-metrics-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function attempt(usage, startedAt, endedAt) {
  const metrics = { assistantMessages: 0, usage: [] };
  collectUsage(metrics, event(usage));
  return { ...metrics, startedAt, endedAt };
}
function promptMetrics() {
  return { prompts: 0, promptAttempts: [], assistantMessages: 0, usage: [], modelErrors: [], model: { provider: "mock", id: "offline" } };
}

test("usage distinguishes real zero from missing or null fields", () => {
  const metrics = { assistantMessages: 0, usage: [] };
  collectUsage(metrics, event(zero));
  assert.deepEqual(summarizeUsage(metrics).usageTotal, zero);
  assert.equal(summarizeUsage(metrics).usageCoverage.status, "complete");
  collectUsage(metrics, event({ input: 4, output: null, cacheRead: 0, totalTokens: 7 }));
  const summary = summarizeUsage(metrics);
  assert.deepEqual(summary.usageTotal, { input: 4, output: null, cacheRead: 0, cacheWrite: null, totalTokens: 7 });
  assert.equal(summary.usageKnown.output, 0);
  assert.equal(summary.usageCoverage.status, "partial");
});

test("every assistant completion is recorded even when usage is absent", () => {
  const metrics = { assistantMessages: 0, usage: [] };
  collectUsage(metrics, { type: "agent_start" });
  collectUsage(metrics, { type: "message_end", message: { role: "user" } });
  collectUsage(metrics, event(undefined));
  collectUsage(metrics, { type: "agent_end" });
  assert.equal(metrics.assistantMessages, 1);
  assert.equal(metrics.usage.length, 1);
  assert.ok(Date.parse(metrics.endedAt) >= Date.parse(metrics.startedAt));
  assert.equal(summarizeUsage(metrics).usageTotal.totalTokens, null);
  assert.equal(summarizeUsage(metrics).usageKnown.totalTokens, null);
  assert.equal(summarizeUsage(metrics).usageCoverage.status, "partial");
});

test("a prompt with no assistant response does not claim zero usage", () => {
  const summary = summarizeUsage({ prompts: 1, assistantMessages: 0, usage: [] });
  assert.equal(summary.usageTotal.totalTokens, null);
  assert.equal(summary.usageKnown.totalTokens, null);
  assert.equal(summary.usageCoverage.status, "unknown");
});

test("two retries retain all three attempts without recounting the latest snapshot", (t) => {
  const dir = temporaryRun(t);
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ productionRoute: "tianshu-replication", planMetrics: { usageTotal: { totalTokens: 999 } } }));
  for (let index = 0; index < 3; index++) {
    const start = `2026-09-08T00:00:0${index * 2}.000Z`;
    const end = `2026-09-08T00:00:0${index * 2 + 1}.000Z`;
    appendRunMetrics(dir, "planner", attempt({ ...zero, input: 3, output: 2, totalTokens: 5 }, start, end), index < 2 ? "failed" : "completed");
  }
  const summary = readRunMetrics(dir);
  assert.equal(summary.route, "tianshu-replication");
  assert.equal(summary.attemptCount, 3);
  assert.deepEqual(summary.attempts.map((row) => row.outcome), ["failed", "failed", "completed"]);
  assert.equal(summary.usageTotal.totalTokens, 15);
  assert.equal(summary.roles.planner.usageTotal.input, 9);
  assert.equal(summary.wallElapsedMs, 5000);
});

test("wall elapsed spans overlapping roles instead of summing their durations", (t) => {
  const dir = temporaryRun(t);
  appendRunMetrics(dir, "writer", attempt(zero, "2026-09-08T00:00:00Z", "2026-09-08T00:00:10Z"), "completed");
  appendRunMetrics(dir, "reviewer", attempt(zero, "2026-09-08T00:00:05Z", "2026-09-08T00:00:15Z"), "completed");
  const summary = readRunMetrics(dir);
  assert.equal(summary.wallElapsedMs, 15000);
  assert.equal(summary.roles.writer.wallElapsedMs, 10000);
  assert.equal(summary.roles.reviewer.wallElapsedMs, 10000);
});

test("old records retain known usage but cannot prove complete coverage", (t) => {
  const dir = temporaryRun(t);
  fs.mkdirSync(path.join(dir, "metrics"));
  fs.writeFileSync(path.join(dir, "metrics", "planner.json"), JSON.stringify({ role: "planner", usage: [{ ...zero, input: 5, totalTokens: 5 }], usageTotal: { totalTokens: 5 } }));
  const old = readRunMetrics(dir);
  assert.equal(old.route, null);
  assert.equal(old.usageTotal.totalTokens, null);
  assert.equal(old.usageKnown.totalTokens, 5);
  assert.equal(old.usageCoverage.status, "unknown");
  assert.equal(old.wallElapsedMs, null);
  appendRunMetrics(dir, "planner", attempt(zero, "2026-09-08T00:00:00Z", "2026-09-08T00:00:01Z"), "completed");
  const updated = readRunMetrics(dir);
  assert.equal(updated.attemptCount, 2);
  assert.equal(updated.usageTotal.totalTokens, null);
  assert.equal(updated.usageKnown.totalTokens, 5);
  assert.equal(updated.wallTimeCoverage, "partial");
});

test("missing records remain unknown and reading never creates or changes files", (t) => {
  const dir = temporaryRun(t);
  const empty = readRunMetrics(dir);
  assert.equal(empty.usageTotal.input, null);
  assert.equal(empty.usageCoverage.status, "unknown");
  assert.deepEqual(fs.readdirSync(dir), []);
  appendRunMetrics(dir, "continuity", attempt(zero, "2026-09-08T00:00:00Z", "2026-09-08T00:00:01Z"), "completed");
  const file = path.join(dir, "metrics", "continuity.json");
  const before = fs.readFileSync(file, "utf8");
  const stat = fs.statSync(file);
  assert.equal(readRunMetrics(dir).roles.continuity.usageTotal.totalTokens, 0);
  assert.equal(fs.readFileSync(file, "utf8"), before);
  assert.equal(fs.statSync(file).mtimeMs, stat.mtimeMs);
  assert.deepEqual(fs.readdirSync(path.join(dir, "metrics")), ["continuity.json"]);
});

test("a session prompt with multiple messages preserves raw usage and does not claim provider call accounting", async (t) => {
  const dir = temporaryRun(t);
  const metrics = promptMetrics();
  const usage = { ...zero, input: 4, cacheRead: 3, output: 2, totalTokens: 9, vendorReportedField: 5 };
  await promptWithWatchdog({ prompt: async () => {
    collectUsage(metrics, event(usage));
    collectUsage(metrics, event(zero));
  }, abort: async () => {} }, metrics, "offline fixture");
  assert.deepEqual(metrics.usage[0].rawUsage, usage);
  assert.deepEqual(metrics.usage[0].model, { provider: "mock", id: "offline" });
  assert.equal(metrics.promptAttempts.length, 1);
  assert.equal(metrics.promptAttempts[0].assistantMessagesAfter, 2);
  appendRunMetrics(dir, "writer", metrics, "completed");
  const summary = readRunMetrics(dir);
  assert.equal(summary.usageCoverage.scope, "recorded_assistant_messages");
  assert.equal(summary.usageCoverage.status, "complete");
  assert.equal(summary.usageTotal.totalTokens, 9);
  assert.equal(summary.promptRequestCoverage.scope, "session.prompt");
  assert.equal(summary.promptRequestCoverage.status, "complete");
  assert.equal(summary.promptRequestCoverage.recordedAttempts, 1);
  assert.equal(summary.providerRequestCoverage.status, "unknown");
  assert.equal(summary.providerRequestCoverage.actualCallCount, null);
  assert.equal(summary.cost.status, "unknown");
  assert.equal(summary.cost.amount, null);
  assert.deepEqual(summary.models, [{ provider: "mock", id: "offline" }]);
});

test("a rejection without another message after success leaves request coverage unknown", async (t) => {
  const dir = temporaryRun(t);
  const metrics = promptMetrics();
  let calls = 0;
  const session = { prompt: async () => {
    if (++calls === 2) throw new Error("offline rejection");
    collectUsage(metrics, event({ ...zero, totalTokens: 5 }));
  }, abort: async () => {} };
  await promptWithWatchdog(session, metrics, "first prompt");
  await assert.rejects(promptWithWatchdog(session, metrics, "second prompt"), /offline rejection/);
  assert.equal(calls, 2);
  assert.deepEqual(metrics.promptAttempts.map((row) => row.status), ["succeeded", "error"]);
  assert.equal(metrics.promptAttempts[1].assistantMessagesBefore, 1);
  assert.equal(metrics.promptAttempts[1].assistantMessagesAfter, 1);
  assert.ok(metrics.promptAttempts.every((row) => row.startedAt && row.endedAt));
  appendRunMetrics(dir, "writer", metrics, "failed");
  const summary = readRunMetrics(dir);
  assert.equal(summary.usageCoverage.status, "complete");
  assert.equal(summary.usageKnown.totalTokens, 5);
  assert.equal(summary.promptRequestCoverage.status, "unknown");
  assert.equal(summary.promptRequestCoverage.errorAttempts, 1);
  assert.ok(summary.promptRequestCoverage.reasons.includes("prompt_error_may_have_unreported_provider_usage"));
  assert.equal(summary.cost.amount, null);
});

test("a watchdog timeout without a new assistant message retains unknown request usage", async (t) => {
  const dir = temporaryRun(t);
  const metrics = promptMetrics();
  let unblock;
  let calls = 0;
  let aborts = 0;
  const session = { prompt: async () => {
    if (++calls === 1) collectUsage(metrics, event(zero));
    else await new Promise((resolve) => { unblock = resolve; });
  }, abort: async () => { aborts += 1; unblock(); } };
  await promptWithWatchdog(session, metrics, "successful fixture");
  await assert.rejects(promptWithWatchdog(session, metrics, "timed-out fixture", 5), /watchdog/);
  assert.equal(calls, 2);
  assert.equal(aborts, 1);
  assert.equal(metrics.promptAttempts[1].status, "timeout");
  assert.equal(metrics.promptAttempts[1].assistantMessagesAfter, 1);
  appendRunMetrics(dir, "writer", metrics, "failed");
  const summary = readRunMetrics(dir);
  assert.equal(summary.usageCoverage.status, "complete");
  assert.equal(summary.promptRequestCoverage.status, "unknown");
  assert.equal(summary.promptRequestCoverage.timeoutAttempts, 1);
  assert.ok(summary.promptRequestCoverage.reasons.includes("prompt_timeout_may_have_unreported_provider_usage"));
});

test("model-error retries retain each session prompt outcome and its recorded message usage", async () => {
  const metrics = promptMetrics();
  let calls = 0;
  const session = { prompt: async () => {
    collectUsage(metrics, event({ ...zero, totalTokens: ++calls }));
    if (calls < 3) metrics.modelErrors.push({ stopReason: "error" });
  }, abort: async () => {} };
  await promptWithWatchdog(session, metrics, "offline retry fixture");
  assert.equal(calls, 3);
  assert.equal(metrics.prompts, 1);
  assert.deepEqual(metrics.promptAttempts.map((row) => row.status), ["error", "error", "succeeded"]);
  assert.deepEqual(metrics.promptAttempts.map((row) => row.retryIndex), [0, 1, 2]);
  assert.equal(summarizeUsage(metrics).usageTotal.totalTokens, 6);
  const requests = summarizePromptRequests(metrics);
  assert.equal(requests.status, "unknown");
  assert.equal(requests.promptInvocations, 1);
  assert.equal(requests.recordedAttempts, 3);
  assert.equal(requests.errorAttempts, 2);
});

test("legacy or unfinished prompts do not become complete from message coverage", () => {
  const metrics = promptMetrics();
  collectUsage(metrics, event(zero));
  delete metrics.promptAttempts;
  metrics.prompts = 1;
  assert.equal(summarizeUsage(metrics).usageCoverage.status, "complete");
  assert.equal(summarizePromptRequests(metrics).status, "unknown");
  metrics.promptAttempts = [{ promptIndex: 1, status: "running", endedAt: null }];
  const pending = summarizePromptRequests(metrics);
  assert.equal(pending.status, "unknown");
  assert.equal(pending.unfinishedAttempts, 1);
});
