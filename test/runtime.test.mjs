import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRun, loadManifest, saveManifest } from "../src/core.mjs";
import { clearStaleRunLock, runProduction, withRunLock } from "../src/runtime.mjs";

function setState(runDir, state) {
  const manifest = loadManifest(runDir);
  manifest.state = state;
  saveManifest(runDir, manifest);
}

function fakeOperations() {
  const cycles = new Map();
  return {
    cycles,
    async produceScripts(runDir) { setState(runDir, "screenplay_reviewing"); },
    async reviewScripts(runDir) {
      const key = `${runDir}:screenplay`, cycle = (cycles.get(key) || 0) + 1;cycles.set(key, cycle);
      const action = cycle === 1 ? "repair" : "pass";
      setState(runDir, action === "repair" ? "screenplay_repairing" : "screenplay_passed");
      return { plan: { action, stage: "screenplay" } };
    },
    applyRepair(runDir, report) { setState(runDir, report.plan.stage === "screenplay" ? "screenplay_producing" : "storyboard_producing"); },
    async produceStoryboards(runDir) { setState(runDir, "storyboard_reviewing"); },
    async reviewStoryboards(runDir) {
      const key = `${runDir}:storyboard`, cycle = (cycles.get(key) || 0) + 1;cycles.set(key, cycle);
      const action = cycle === 1 ? "repair" : "pass";
      setState(runDir, action === "repair" ? "storyboard_repairing" : "final_review");
      return { plan: { action, stage: "storyboard" } };
    },
    deliveryGate() { return { passed: true }; },
  };
}

test("one production command loops through screenplay and storyboard repairs to delivery readiness", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-runtime-"));
  const { dir } = createRun(root, { title: "自动制片", episodes: 30, input: "目标市场：美国" });
  setState(dir, "approved");
  const operations = fakeOperations();
  const result = await runProduction(dir, operations);
  assert.equal(result.state, "ready_to_deliver");
  assert.equal(operations.cycles.get(`${dir}:screenplay`), 2);
  assert.equal(operations.cycles.get(`${dir}:storyboard`), 2);
  assert.ok(fs.readFileSync(path.join(dir, "events.jsonl"), "utf8").includes("state_progress"));
});

test("two runs keep independent repair history and state", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-runtime-isolation-"));
  const first = createRun(root, { title: "第一部", episodes: 30, input: "目标市场：美国" }).dir;
  const second = createRun(root, { title: "第二部", episodes: 30, input: "目标市场：美国" }).dir;
  setState(first, "approved");setState(second, "approved");
  const operations = fakeOperations();
  await runProduction(first, operations);await runProduction(second, operations);
  assert.equal(loadManifest(first).state, "ready_to_deliver");
  assert.equal(loadManifest(second).state, "ready_to_deliver");
  assert.equal(operations.cycles.get(`${first}:screenplay`), 2);
  assert.equal(operations.cycles.get(`${second}:screenplay`), 2);
});

test("run lock rejects a second orchestrator while the first owns the run", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-runtime-lock-"));
  const { dir } = createRun(root, { title: "锁", episodes: 30, input: "目标市场：美国" });
  let release;
  const first = withRunLock(dir, () => new Promise((resolve) => { release = resolve; }));
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(() => withRunLock(dir, async () => null), /already locked/);
  release();await first;
  assert.equal(fs.existsSync(path.join(dir, ".lock")), false);
});

test("an explicit stale-lock command clears only an old dead owner", () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"tianshu-runtime-stale-lock-")),{dir}=createRun(root,{title:"旧锁",episodes:30,input:"目标市场：美国"});fs.writeFileSync(path.join(dir,".lock"),`${JSON.stringify({pid:999999,startedAt:"2000-01-01T00:00:00.000Z"})}\n`);assert.equal(clearStaleRunLock(dir).cleared,true);assert.equal(fs.existsSync(path.join(dir,".lock")),false);
});
