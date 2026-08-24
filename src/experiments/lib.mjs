import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import {
  createAgentSession,
  defineTool,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

const require = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
export const { Type } = require("typebox");

export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
export const EXPERIMENT_ROOT = path.join(ROOT, "experiments", "core");

export function sha(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

export function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function writeText(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${String(value).trimEnd()}\n`, "utf8");
  fs.renameSync(temporary, file);
}

export function writeJson(file, value) {
  writeText(file, JSON.stringify(value, null, 2));
}

export function readText(file) {
  return fs.readFileSync(file, "utf8");
}

export function readJson(file) {
  return JSON.parse(readText(file));
}

export function createExperimentRun(experiment, fixture) {
  const id = `${experiment}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const runDir = path.join(EXPERIMENT_ROOT, id);
  fs.mkdirSync(runDir, { recursive: true });
  writeJson(path.join(runDir, "manifest.json"), {
    id,
    experiment,
    startedAt: new Date().toISOString(),
    fixtureDigest: sha(stable(fixture)),
    model: "kimi-coding/k3-256k",
    state: "running",
  });
  return { id, runDir };
}

export function finishRun(runDir, result) {
  const manifest = readJson(path.join(runDir, "manifest.json"));
  manifest.finishedAt = new Date().toISOString();
  manifest.state = result.outcome;
  manifest.result = result;
  writeJson(path.join(runDir, "manifest.json"), manifest);
  writeJson(path.join(runDir, "metrics.json"), result.metrics || {});
}

export function safeRef(runDir, ref, allowedRoots) {
  if (typeof ref !== "string" || !ref.trim()) throw new Error("artifact ref is required");
  const resolved = path.resolve(runDir, ref);
  const allowed = allowedRoots.some((root) => {
    const base = path.resolve(runDir, root);
    return resolved === base || resolved.startsWith(`${base}${path.sep}`);
  });
  if (!allowed) throw new Error(`artifact ref outside authorized roots: ${ref}`);
  return resolved;
}

const sessionPrefixes = new WeakMap();

export async function createPiExperimentSession({ runDir, role, systemPrompt, customTools, toolNames, thinkingLevel = "off" }) {
  const modelRuntime = await ModelRuntime.create();
  const model = modelRuntime.getModel("kimi-coding", "k3-256k");
  if (!model) throw new Error("Pi cannot resolve kimi-coding/k3-256k");
  const metrics = { role, prompts: 0, turns: 0, toolCalls: 0, compactions: 0, usage: [], events: [], modelErrors: [] };
  const { session } = await createAgentSession({
    cwd: ROOT,
    modelRuntime,
    model,
    thinkingLevel,
    tools: toolNames,
    customTools,
    sessionManager: SessionManager.inMemory(ROOT),
  });
  sessionPrefixes.set(session, systemPrompt);
  session.subscribe((event) => {
    if (event.type === "turn_end") metrics.turns += 1;
    if (event.type === "tool_execution_start") {
      metrics.toolCalls += 1;
      metrics.events.push({ type: "tool_start", tool: event.toolName, at: Date.now() });
    }
    if (event.type === "compaction_end") metrics.compactions += 1;
    if (event.type === "message_end" && event.message?.role === "assistant" && event.message?.usage) {
      const u = event.message.usage;
      metrics.usage.push({ input: u.input ?? null, output: u.output ?? null, cacheRead: u.cacheRead ?? null, cacheWrite: u.cacheWrite ?? null, totalTokens: u.totalTokens ?? null });
    }
    if (event.type === "message_end" && event.message?.role === "assistant" && event.message?.stopReason === "error") {
      metrics.modelErrors.push({ at: Date.now(), stopReason: "error" });
    }
  });
  return { session, metrics };
}

export async function promptWithWatchdog(session, metrics, prompt, timeoutMs = 180_000) {
  const prefix = metrics.prompts === 0 ? sessionPrefixes.get(session) : "";
  metrics.prompts += 1;
  const request = prefix ? `Role instructions for this session:\n${prefix}\n\nTask:\n${prompt}` : prompt;
  for (let attempt = 0; attempt < 3; attempt++) {
    const errorsBefore = metrics.modelErrors?.length || 0;
    let timeout = false;
    const timer = setTimeout(() => { timeout = true; void session.abort(); }, timeoutMs);
    try {
      await session.prompt(request);
    } finally {
      clearTimeout(timer);
    }
    if (timeout) throw new Error(`Pi task exceeded ${timeoutMs}ms watchdog`);
    if ((metrics.modelErrors?.length || 0) === errorsBefore) return;
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 1_500 * (attempt + 1)));
  }
  throw new Error("Pi model returned an error without a usable response after 3 attempts");
}

export { defineTool };
