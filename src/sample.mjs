export function createSampleScope(sourceTotalEpisodes = null) {
  if (sourceTotalEpisodes !== null
    && (!Number.isInteger(sourceTotalEpisodes) || sourceTotalEpisodes < 3)) {
    throw new Error("sample sourceTotalEpisodes must be null or an integer >= 3");
  }
  return {
    kind: "sample",
    sourceEpisodeRange: [1, 3],
    sourceTotalEpisodes,
  };
}

export function sampleLabel(manifest) {
  return manifest.scope?.kind === "sample" ? "【原剧第1–3集样例】" : "";
}

export function sampleContext(manifest) {
  if (manifest.scope?.kind !== "sample") return "";
  return [
    sampleLabel(manifest),
    "本次只覆盖原剧第1–3集，逐集保留其核心事件与顺序；不得把全剧或后续剧情压缩进这三集。",
    "第3集可以保留未解决的冲突、结尾钩子和倒叙承接；不得为了让小样闭环而虚构大结局。",
    "按样例范围评价剧情保留、节奏和跨集承接；交付仅代表原剧前3集。",
  ].join("\n");
}

export function deliveryScope(manifest) {
  const sample = manifest.scope?.kind === "sample";
  return {
    scope: sample ? manifest.scope : { kind: "full-series" },
    episodes: manifest.episodes,
    isFullSeries: !sample,
  };
}
