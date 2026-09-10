import assert from "node:assert/strict";
import test from "node:test";
import { semanticRepairPlan } from "../src/review.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertReviewerSubmitted, checkpointWindowReview, episodePayload, priorRepairFindingIds, reviewPrompt, reviewTimeoutMs, seriesReviewSubmissionTool } from "../src/semantic-review.mjs";
import { writeText } from "../src/core.mjs";

function finding(id, episode, overrides = {}) {
  return {
    id,
    episode,
    severity: "P1",
    scope: "local",
    category: `category-${id}`,
    evidence: `evidence ${id}`,
    reason: `reason ${id}`,
    acceptance: `acceptance ${id}`,
    repairInstruction: `repair ${id}`,
    preserve: [],
    doNotChange: [],
    disposition: "repair",
    ...overrides,
  };
}

function options(overrides = {}) {
  return { stage: "screenplay", totalEpisodes: 30, cycle: 1, maxCycles: 3, systemicEpisodeThreshold: 3, priorFindingIds: [], artifactDigest: "artifact", contractDigest: "contract", ...overrides };
}

test("screenplay and storyboard share evidence and source uncertainty boundaries", () => {
  for (const stage of ["screenplay", "storyboard"]) {
    const prompt = reviewPrompt(stage, "production contract");
    assert.match(prompt, /不能把逐字逐动作复刻当作目标/);
    assert.match(prompt, /相同台词、类似音效、服装颜色或外貌相似均不能单独证明同一时刻或同一人物/);
    assert.match(prompt, /源稿未确认的人物映射、关系或画外过程须保留未知/);
    assert.match(prompt, /不得要求新增未获大纲支持的画外事件来补齐因果/);
    assert.match(prompt, /真实非阻断问题可由终审标为 accepted_non_blocking/);
  }
  assert.match(reviewPrompt("screenplay", "contract"), /只用 screenplay 约束验收剧本/);
  assert.match(reviewPrompt("storyboard", "contract"), /逐镜对照源剧本.*节奏时长.*可拍性/);
});

test("sample review timeout is bounded while formal review timeouts stay unchanged", () => {
  const sample = { scope: { kind: "sample" } };
  assert.equal(reviewTimeoutMs(sample, "window"), 300_000);
  assert.equal(reviewTimeoutMs(sample, "series"), 300_000);
  assert.equal(reviewTimeoutMs({}, "window"), 900_000);
  assert.equal(reviewTimeoutMs({}, "series"), 1_800_000);
});

test("completed window checkpoint is persisted and requires identical input and instructions", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-review-checkpoint-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "window.json");
  const input = { systemPrompt: "review instruction", prompt: "canonical and full episode text" };
  let calls = 0;
  const runReview = async () => ({ findings: [], summary: `window result ${++calls}` });
  const first = await checkpointWindowReview(file, input, runReview);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { ...input, result: first });
  assert.deepEqual(await checkpointWindowReview(file, input, runReview), first);
  assert.equal(calls, 1);

  const changedInput = { ...input, prompt: `${input.prompt}\nchanged episode` };
  assert.equal((await checkpointWindowReview(file, changedInput, runReview)).summary, "window result 2");
  const changedInstructions = { ...changedInput, systemPrompt: `${input.systemPrompt}\noperator note` };
  assert.equal((await checkpointWindowReview(file, changedInstructions, runReview)).summary, "window result 3");
  assert.equal(calls, 3);
});

test("failed window review never creates a reusable checkpoint", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-review-failed-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "window.json");
  await assert.rejects(checkpointWindowReview(file, { systemPrompt: "review", prompt: "episodes" }, async () => {
    throw new Error("window Reviewer did not submit");
  }), /did not submit/);
  assert.equal(fs.existsSync(file), false);
});

test("multiple unrelated local P1 findings remain automatically repairable", () => {
  const plan = semanticRepairPlan([finding("a", 2), finding("b", 8), finding("c", 19)], options());
  assert.equal(plan.action, "repair");
  assert.deepEqual(plan.episodes, [2, 8, 19]);
});

test("P0, upstream defects, systemic categories, repeated findings, and exhausted budgets fail closed", () => {
  assert.equal(semanticRepairPlan([finding("p0", 2, { severity: "P0" })], options()).action, "blocked");
  assert.equal(semanticRepairPlan([finding("up", 2, { scope: "upstream" })], options()).action, "blocked");
  assert.equal(semanticRepairPlan([finding("a", 2, { category: "continuity" }), finding("b", 8, { category: "continuity" }), finding("c", 19, { category: "continuity" })], options()).action, "blocked");
  assert.equal(semanticRepairPlan([finding("repeat", 2)], options({ priorFindingIds: ["repeat"] })).action, "blocked");
  assert.equal(semanticRepairPlan([finding("late", 2)], options({ cycle: 3 })).action, "blocked");
});

test("P2 must be explicitly repaired or accepted as non-blocking", () => {
  const accepted = semanticRepairPlan([finding("minor", 2, { severity: "P2", disposition: "accepted_non_blocking" })], options());
  assert.equal(accepted.action, "pass");
  const repair = semanticRepairPlan([finding("minor", 2, { severity: "P2", disposition: "repair" })], options());
  assert.equal(repair.action, "repair");
  assert.throws(() => semanticRepairPlan([finding("minor", 2, { severity: "P2", disposition: "unresolved" })], options()), /P2 finding requires a disposition/);
  const legacy=semanticRepairPlan([finding("legacy-minor",2,{severity:"P2",disposition:undefined})],options({requireP2Disposition:false}));assert.equal(legacy.action,"pass");assert.equal(legacy.findings[0].disposition,"accepted_non_blocking");
});

test("planning P1 findings can repair the unapproved planning bundle", () => {
  const plan = semanticRepairPlan([finding("plan", 0, { scope: "upstream" })], options({ stage: "planning" }));
  assert.equal(plan.action, "repair");
  assert.deepEqual(plan.episodes, [0]);
});

test("storyboard review payload contains the complete source screenplay", () => {
  const runDir=fs.mkdtempSync(path.join(os.tmpdir(),"tianshu-review-payload-")),tail="TAIL_EVIDENCE_MUST_BE_REVIEWED";
  writeText(path.join(runDir,"screenplay","ep-01.md"),`${"剧情。".repeat(5000)}${tail}`);writeText(path.join(runDir,"storyboard","ep-01.md"),"storyboard");
  assert.match(episodePayload(runDir,"storyboard",1),new RegExp(tail));
});

test("Reviewer must explicitly submit even when it has zero findings", () => {
  assert.throws(()=>assertReviewerSubmitted(false,"screenplay window Reviewer"),/did not submit/);assert.doesNotThrow(()=>assertReviewerSubmitted(true,"screenplay window Reviewer"));
});

test("final review tool rejects missing P2 disposition before accepting, then accepts corrected submission", async () => {
  const received = [];
  const tool = seriesReviewSubmissionTool({ stage: "planning", totalEpisodes: 3, onSubmit: (value) => received.push(value) });
  const p2 = finding("source-name-ambiguity", 0, { severity: "P2", disposition: undefined });
  const rejected = await tool.execute("first", { summary: "需要保留原稿姓名疑点", findings: [p2] });
  assert.equal(rejected.terminate, false);
  assert.equal(rejected.details.accepted, false);
  assert.match(rejected.content[0].text, /P2 finding requires a disposition/);
  assert.equal(received.length, 0);
  const accepted = await tool.execute("fixed", { summary: "姓名疑点已注明，无新增事实", findings: [{ ...p2, disposition: "accepted_non_blocking" }] });
  assert.equal(accepted.terminate, true);
  assert.equal(received.length, 1);
  assert.equal(semanticRepairPlan(received[0].findings, options({ stage: "planning" })).action, "pass");
});

test("re-evaluating a blocked review is not miscounted as a failed repair", () => {
  const existing = finding("phone-state", 2, { scope: "pair" });
  const blocked = { plan: { action: "blocked", findings: [existing] } };
  assert.deepEqual(priorRepairFindingIds(blocked), []);
  assert.equal(semanticRepairPlan([existing], options({ cycle: 2, priorFindingIds: priorRepairFindingIds(blocked) })).action, "repair");
  const repaired = { plan: { action: "repair", findings: [existing] } };
  assert.deepEqual(priorRepairFindingIds(repaired, { repairPending: true }), []);
  assert.equal(semanticRepairPlan([existing], options({ cycle: 2, priorFindingIds: priorRepairFindingIds(repaired, { repairPending: true }) })).action, "repair");
  assert.equal(semanticRepairPlan([existing], options({ cycle: 2, priorFindingIds: priorRepairFindingIds(repaired) })).action, "blocked");
});
