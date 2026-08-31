import assert from "node:assert/strict";
import test from "node:test";
import { dialogueCellErrors, screenplayBilingualErrors } from "../src/bilingual.mjs";

test("storyboard dialogue accepts a real bilingual pair and no-dialogue marker", () => {
  assert.deepEqual(dialogueCellErrors("Maya：成交。<br>EN: Deal.<br>表演：平静", "ep01-s01"), []);
  assert.deepEqual(dialogueCellErrors("无台词", "ep01-s02"), []);
});

test("storyboard dialogue rejects duplicated English, same-as-above, and reversed order", () => {
  assert.ok(dialogueCellErrors('Ethan："She."<br>EN: "She."').some((error) => error.includes("真实中文")));
  assert.ok(dialogueCellErrors("Nora：This is final.<br>EN: 同上").some((error) => error.includes("同上")));
  assert.ok(dialogueCellErrors("EN: Deal.<br>中文：成交。").some((error) => error.includes("顺序颠倒")));
});

test("screenplay dialogue requires paired Chinese then English markers", () => {
  const valid = "MAYA（中）：成交。\nMAYA（EN）：Deal.";
  assert.deepEqual(screenplayBilingualErrors(valid), []);
  assert.ok(screenplayBilingualErrors("EN: Maya — Deal.").some((error) => error.includes("缺少对应中文")));
  assert.ok(screenplayBilingualErrors("MAYA（中）：成交。").some((error) => error.includes("缺少对应英文")));
});
