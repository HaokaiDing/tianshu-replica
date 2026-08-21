import fs from "node:fs";
import path from "node:path";
import { loadManifest, readJson, taskPath, writeJson } from "./core.mjs";

export function normalizeFinding(finding) {
  const episode = Number(finding.episode);
  if (!Number.isInteger(episode) || episode < 1) throw new Error("review finding requires a positive episode");
  if (!['P0', 'P1', 'P2'].includes(finding.severity)) throw new Error("review finding has invalid severity");
  if (!['local', 'pair', 'upstream'].includes(finding.scope)) throw new Error("review finding has invalid scope");
  return { ...finding, episode };
}

export function repairPlan(findings, totalEpisodes) {
  const normalized = findings.map(normalizeFinding);
  const systemic = normalized.filter((item) => item.scope === 'upstream' || item.severity === 'P0');
  if (systemic.length) return { action: 'blocked', reasons: systemic };
  const p1 = normalized.filter((item) => item.severity === 'P1');
  if (p1.length > 2) return { action: 'blocked', reasons: p1 };
  const episodes = [...new Set(p1.flatMap((item) => item.scope === 'pair' ? [item.episode, Math.min(totalEpisodes, item.episode + 1)] : [item.episode]))].sort((a,b)=>a-b);
  return { action: episodes.length ? 'repair' : 'pass', episodes, findings: p1 };
}

export function markStale(runDir, repairedEpisodes) {
  const manifest = loadManifest(runDir);
  const stale = new Set();
  for (const episode of repairedEpisodes) {
    stale.add(`storyboard-ep-${String(episode).padStart(2, '0')}`);
    if (episode < manifest.episodes) {
      stale.add(`screenplay-ep-${String(episode + 1).padStart(2, '0')}`);
      stale.add(`storyboard-ep-${String(episode + 1).padStart(2, '0')}`);
    }
  }
  for (const id of stale) {
    const file = taskPath(runDir, id);
    const prior = fs.existsSync(file) ? readJson(file) : { id };
    writeJson(file, { ...prior, state: 'stale', staleReason: 'upstream screenplay revised' });
  }
  return [...stale].sort();
}
