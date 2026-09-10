import assert from "node:assert/strict";
import test from "node:test";
import { createSampleScope, deliveryScope, sampleContext, sampleLabel } from "../src/sample.mjs";

test("sample scope retains the original episode range and known or unknown total", () => {
  assert.deepEqual(createSampleScope(), {
    kind: "sample", sourceEpisodeRange: [1, 3], sourceTotalEpisodes: null,
  });
  assert.deepEqual(createSampleScope(60), {
    kind: "sample", sourceEpisodeRange: [1, 3], sourceTotalEpisodes: 60,
  });
  assert.equal(createSampleScope(3).sourceTotalEpisodes, 3);
});

test("sample scope rejects a source that cannot contain the three requested episodes", () => {
  for (const total of [0, 2, -1, 3.5, "60", NaN, Infinity]) {
    assert.throws(() => createSampleScope(total), /null or an integer >= 3/);
  }
});

test("sample context preserves an open third-episode ending and delivery stays a sample", () => {
  const manifest = { episodes: 3, scope: createSampleScope(60) };
  assert.equal(sampleLabel(manifest), "【原剧第1–3集样例】");
  const context = sampleContext(manifest);
  assert.match(context, /只覆盖原剧第1–3集/);
  assert.match(context, /不得把全剧或后续剧情压缩/);
  assert.match(context, /结尾钩子和倒叙承接/);
  assert.match(context, /不得为了让小样闭环而虚构大结局/);
  assert.deepEqual(deliveryScope(manifest), {
    scope: createSampleScope(60), episodes: 3, isFullSeries: false,
  });
});

test("ordinary production keeps its full episode count without sample instructions", () => {
  for (const episodes of [30, 60]) {
    const manifest = { episodes };
    assert.equal(sampleLabel(manifest), "");
    assert.equal(sampleContext(manifest), "");
    assert.deepEqual(deliveryScope(manifest), {
      scope: { kind: "full-series" }, episodes, isFullSeries: true,
    });
  }
});
