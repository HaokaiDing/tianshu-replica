import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  PRODUCTION_CONTRACT_FILE,
  createLegacyProductionContract,
  createProductionContract,
  loadProductionContract,
  productionContractDigest,
  productionContractMarkdown,
  validateProductionContract,
  writeProductionContract,
} from "../src/production-contract.mjs";

test("new production contracts default to the female vertical-drama profile", () => {
  const contract = createProductionContract();
  assert.equal(contract.format.audience, "female");
  assert.deepEqual(contract.screenplay.episodeDurationSeconds, { min: 90, max: 100 });
  assert.deepEqual(contract.storyboard.episodeDurationSeconds, { min: 90, max: 100 });
  assert.deepEqual(contract.storyboard.shotCount, { min: 12, max: 24 });
  assert.deepEqual(contract.storyboard.shotDurationSeconds, { min: 3, max: 10 });
  assert.equal(contract.screenplay.maxScenes, 4);
  assert.deepEqual(contract.promotion.requiredEpisodes, [1, 2, 3]);
  assert.equal(contract.promotion.coldOpenWithinSeconds, 3);
  assert.equal(contract.promotion.requireSemanticHook, true);
  assert.deepEqual(contract.revision.maxSemanticRounds, { planning: 3, screenplay: 3, storyboard: 3 });
  assert.equal(contract.revision.systemicEpisodeThreshold, 3);
  assert.equal(contract.revision.maxContinuityRepairAttempts, 2);
  assert.equal(contract.revision.requireP2Disposition, true);
  assert.equal(contract.delivery.autoDeliver, true);
});

test("English dialogue limit is configurable without erasing nested defaults", () => {
  const contract = createProductionContract({ screenplay: { englishDialogueWordLimit: 190 } });
  assert.equal(contract.screenplay.englishDialogueWordLimit, 190);
  assert.equal(contract.screenplay.maxScenes, 4);
  assert.deepEqual(contract.screenplay.episodeDurationSeconds, { min: 90, max: 100 });
});

test("missing contract loads an explicit legacy compatibility contract", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-contract-"));
  const contract = loadProductionContract(runDir);
  assert.equal(contract.legacy, true);
  assert.equal(contract.profile, "legacy-unversioned-run");
  assert.deepEqual(contract.storyboard.episodeDurationSeconds, { min: 60, max: 120 });
  assert.deepEqual(contract.screenplay.episodeDurationSeconds, { min: 60, max: 120 });
  assert.equal(contract.delivery.autoDeliver, false);
  assert.equal(fs.existsSync(path.join(runDir, PRODUCTION_CONTRACT_FILE)), false);
});

test("contracts round-trip through the run canonical directory", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-contract-"));
  const expected = createProductionContract({ screenplay: { englishDialogueWordLimit: 210 } });
  const file = writeProductionContract(runDir, expected);
  assert.equal(file, path.join(runDir, PRODUCTION_CONTRACT_FILE));
  assert.deepEqual(loadProductionContract(runDir), expected);
});

test("validation rejects malformed ranges and revision policy", () => {
  const contract = createProductionContract();
  contract.storyboard.shotCount = { min: 24, max: 12 };
  contract.revision.maxSemanticRounds.screenplay = -1;
  contract.revision.requireP2Disposition = "yes";
  const errors = validateProductionContract(contract);
  assert.ok(errors.some((error) => error.includes("shotCount.min")));
  assert.ok(errors.some((error) => error.includes("maxSemanticRounds.screenplay")));
  assert.ok(errors.some((error) => error.includes("requireP2Disposition")));
});

test("digest is deterministic across object key order and changes with policy", () => {
  const first = createProductionContract();
  const reordered = Object.fromEntries(Object.entries(first).reverse());
  assert.equal(productionContractDigest(first), productionContractDigest(reordered));
  assert.notEqual(productionContractDigest(first), productionContractDigest(createProductionContract({ delivery: { autoDeliver: false } })));
});

test("markdown exposes the operational limits and legacy status", () => {
  const current = productionContractMarkdown(createProductionContract());
  assert.match(current, /90–100 秒/);
  assert.match(current, /EP1、EP2、EP3/);
  assert.match(current, /P2：必须明确处置/);
  assert.match(current, /自动交付：是/);
  const legacy = productionContractMarkdown(createLegacyProductionContract());
  assert.match(legacy, /旧项目兼容模式/);
  assert.match(legacy, /60–120 秒/);
  assert.match(legacy, /自动交付：否/);
});
