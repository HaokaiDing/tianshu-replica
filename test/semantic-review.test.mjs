import assert from "node:assert/strict";
import test from "node:test";
import { semanticRepairPlan } from "../src/review.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertReviewerSubmitted, episodePayload } from "../src/semantic-review.mjs";
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
