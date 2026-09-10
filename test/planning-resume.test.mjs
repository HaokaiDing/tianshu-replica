import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { completedPlanningMetrics } from "../src/agents.mjs";

test("completed planning remains reusable after a review reception failure", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-planning-resume-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, "canonical"));
  fs.mkdirSync(path.join(dir, "metrics"));
  const saveState = (state, planning = 0) => fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ state, reviewCycles: { planning } }));
  const metricsFile = path.join(dir, "metrics", "planner-cycle-1.json");
  fs.writeFileSync(metricsFile, JSON.stringify({ outcome: "completed", prompts: 1 }));
  saveState("planning");
  assert.equal(completedPlanningMetrics(dir), null);
  for (const name of ["acts.md", "design.md", "outline.md", "characters.md", "ledger.json", "continuity-contract.md", "market.json", "market-contract.md"]) fs.writeFileSync(path.join(dir, "canonical", name), "已有已提交产物");
  assert.equal(completedPlanningMetrics(dir).prompts, 1);
  saveState("returned");
  assert.equal(completedPlanningMetrics(dir), null);
  saveState("planning", 1);
  assert.equal(completedPlanningMetrics(dir), null);
  saveState("planning");
  fs.writeFileSync(metricsFile, JSON.stringify({ outcome: "failed", prompts: 1 }));
  assert.equal(completedPlanningMetrics(dir), null);
});
