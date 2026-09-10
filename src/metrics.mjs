import fs from "node:fs";
import path from "node:path";
import { deliveryScope } from "./sample.mjs";

const fields = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"];
const reported = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;

// Count every assistant completion, including ones whose provider omitted usage.
export function collectUsage(metrics, event) {
  const at = new Date().toISOString();
  if (event.type === "agent_start") {
    metrics.startedAt ??= at;
    metrics.endedAt = null;
  }
  if (event.type === "agent_end") metrics.endedAt = at;
  if (event.type !== "message_end" || event.message?.role !== "assistant") return;
  metrics.usage ??= [];
  // A pre-existing usage array without an event count has unknown historical coverage.
  if (metrics.assistantMessages === undefined && metrics.usage.length === 0) metrics.assistantMessages = 0;
  if (Number.isInteger(metrics.assistantMessages)) metrics.assistantMessages += 1;
  metrics.startedAt ??= at;
  const usage = event.message.usage;
  metrics.usage.push({
    at,
    model: {
      provider: event.message.provider ?? metrics.model?.provider ?? null,
      id: event.message.model ?? metrics.model?.id ?? null,
    },
    // Preserve the SDK's fields; input/cache/output semantics are not rewritten here.
    rawUsage: usage && typeof usage === "object" ? { ...usage } : null,
    ...Object.fromEntries(fields.map((field) => [field, reported(usage?.[field]) ? usage[field] : null])),
  });
}

export function summarizeUsage(metrics = {}) {
  const rows = Array.isArray(metrics.usage) ? metrics.usage : [];
  const count = metrics.assistantMessages;
  const covered = Number.isInteger(count) && count >= 0 && count === rows.length
    && !(metrics.prompts > 0 && rows.length === 0);
  const usageTotal = {}, usageKnown = {}, coverage = {};
  for (const field of fields) {
    const values = rows.map((row) => row?.[field]).filter(reported);
    const complete = covered && values.length === rows.length;
    const sum = values.reduce((total, value) => total + value, 0);
    usageTotal[field] = complete ? sum : null;
    usageKnown[field] = values.length || (covered && rows.length === 0) ? sum : null;
    coverage[field] = { reportedMessages: values.length, complete };
  }
  return {
    usageTotal,
    usageKnown,
    usageCoverage: {
      scope: "recorded_assistant_messages",
      status: !covered ? "unknown" : fields.every((field) => coverage[field].complete) ? "complete" : "partial",
      assistantMessages: Number.isInteger(count) && count >= 0 ? count : null,
      recordedMessages: rows.length,
      fields: coverage,
    },
  };
}

export function summarizePromptRequests(metrics = {}) {
  const rows = Array.isArray(metrics.promptAttempts) ? metrics.promptAttempts : [];
  const prompts = Number.isInteger(metrics.prompts) && metrics.prompts >= 0 ? metrics.prompts : null;
  const indices = rows.map((row) => row.promptIndex);
  const inventoryComplete = Array.isArray(metrics.promptAttempts) && prompts !== null
    && indices.every((index) => Number.isInteger(index) && index >= 1 && index <= prompts)
    && new Set(indices).size === prompts;
  const count = (status) => rows.filter((row) => row.status === status).length;
  const succeededAttempts = count("succeeded");
  const errorAttempts = count("error");
  const timeoutAttempts = count("timeout");
  const unfinishedAttempts = rows.filter((row) => !row.endedAt
    || !["succeeded", "error", "timeout"].includes(row.status)).length;
  const reasons = [];
  if (!inventoryComplete) reasons.push("prompt_attempt_inventory_incomplete");
  if (errorAttempts) reasons.push("prompt_error_may_have_unreported_provider_usage");
  if (timeoutAttempts) reasons.push("prompt_timeout_may_have_unreported_provider_usage");
  if (unfinishedAttempts) reasons.push("prompt_attempt_outcome_unknown");
  return {
    scope: "session.prompt",
    status: reasons.length ? "unknown" : "complete",
    promptInvocations: prompts,
    recordedAttempts: rows.length,
    succeededAttempts,
    errorAttempts,
    timeoutAttempts,
    unfinishedAttempts,
    reasons,
  };
}

function accountingLimits() {
  return {
    providerRequestCoverage: {
      scope: "raw_provider_requests",
      status: "unknown",
      actualCallCount: null,
      reason: "session.prompt may issue multiple provider requests; their inventory is not recorded",
    },
    cost: {
      status: "unknown",
      amount: null,
      currency: null,
      reason: "provider billing and pricing evidence is not recorded",
    },
  };
}

export function appendRunMetrics(runDir, role, metrics, outcome, extra = {}) {
  const file = path.join(runDir, "metrics", `${role}.json`);
  const previous = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
  const { attempts: ignored, ...snapshot } = previous || {};
  const attempts = Array.isArray(previous?.attempts) ? previous.attempts : previous ? [snapshot] : [];
  const record = {
    ...metrics, ...extra, role, outcome,
    startedAt: metrics.startedAt ?? null,
    endedAt: metrics.endedAt ?? new Date().toISOString(),
    ...summarizeUsage(metrics),
    promptRequestCoverage: summarizePromptRequests(metrics),
    ...accountingLimits(),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({ ...record, attempts: [...attempts, record] }, null, 2)}\n`);
  fs.renameSync(temporary, file);
  return record;
}

function summarizeAttempts(attempts) {
  const summaries = attempts.map(summarizeUsage);
  const knownCoverage = attempts.length > 0 && summaries.every((summary) => summary.usageCoverage.status !== "unknown");
  const usage = attempts.flatMap((attempt) => Array.isArray(attempt.usage) ? attempt.usage : []);
  const summary = summarizeUsage({ usage, assistantMessages: knownCoverage ? usage.length : null });
  const promptSummaries = attempts.map(summarizePromptRequests);
  const promptRequestCoverage = {
    scope: "session.prompt",
    status: attempts.length && promptSummaries.every((item) => item.status === "complete") ? "complete" : "unknown",
    promptInvocations: attempts.length && promptSummaries.every((item) => item.promptInvocations !== null)
      ? promptSummaries.reduce((total, item) => total + item.promptInvocations, 0) : null,
    ...Object.fromEntries(["recordedAttempts", "succeededAttempts", "errorAttempts", "timeoutAttempts", "unfinishedAttempts"]
      .map((field) => [field, promptSummaries.reduce((total, item) => total + item[field], 0)])),
    reasons: [...new Set(attempts.length ? promptSummaries.flatMap((item) => item.reasons) : ["no_recorded_attempts"])],
  };
  const models = [];
  for (const model of [...attempts.map((attempt) => attempt.model), ...usage.map((row) => row.model)]) {
    if (!model || (!model.provider && !model.id)) continue;
    const entry = { provider: model.provider ?? null, id: model.id ?? null };
    if (!models.some((known) => known.provider === entry.provider && known.id === entry.id)) models.push(entry);
  }
  const intervals = attempts.map((attempt) => {
    const start = typeof attempt.startedAt === "string" ? Date.parse(attempt.startedAt) : NaN;
    const end = typeof attempt.endedAt === "string" ? Date.parse(attempt.endedAt) : NaN;
    return Number.isFinite(start) && Number.isFinite(end) && end >= start ? { start, end } : null;
  });
  const valid = intervals.filter(Boolean);
  const completeTime = valid.length > 0 && valid.length === attempts.length;
  const start = valid.length ? Math.min(...valid.map((interval) => interval.start)) : null;
  const end = valid.length ? Math.max(...valid.map((interval) => interval.end)) : null;
  return {
    attemptCount: attempts.length,
    ...summary,
    promptRequestCoverage,
    ...accountingLimits(),
    models,
    startedAt: start === null ? null : new Date(start).toISOString(),
    endedAt: end === null ? null : new Date(end).toISOString(),
    // Span of recorded attempts, including idle gaps; overlapping stages are never added.
    wallElapsedMs: completeTime ? end - start : null,
    wallTimeCoverage: completeTime ? "complete" : valid.length ? "partial" : "unknown",
  };
}

// Read only role records. Top-level snapshots and manifest.planMetrics are not added again.
export function readRunMetrics(runDir) {
  const directory = path.join(runDir, "metrics");
  const attempts = [];
  if (fs.existsSync(directory)) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const record = JSON.parse(fs.readFileSync(path.join(directory, entry.name), "utf8"));
      const rows = Array.isArray(record.attempts) ? record.attempts : [record];
      for (const row of rows) attempts.push({ ...row, role: row.role || record.role || entry.name.slice(0, -5) });
    }
  }
  const roles = {};
  for (const role of new Set(attempts.map((attempt) => attempt.role))) {
    roles[role] = summarizeAttempts(attempts.filter((attempt) => attempt.role === role));
  }
  const manifestFile = path.join(runDir, "manifest.json");
  const manifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, "utf8")) : {};
  return { ...(fs.existsSync(manifestFile) ? deliveryScope(manifest) : {}), route: manifest.productionRoute ?? null, ...summarizeAttempts(attempts), roles, attempts };
}
