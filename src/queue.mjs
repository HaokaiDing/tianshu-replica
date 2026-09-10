import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const RUNNABLE = new Set(["approved", "screenplay_producing", "screenplay_reviewing", "screenplay_passed", "storyboard_producing", "storyboard_reviewing", "final_review", "ready_to_deliver"]);
const PAUSED = new Map([["awaiting_approval", "awaiting_outline_approval"], ["needs_human_review", "needs_human_review"], ["awaiting_delivery_approval", "awaiting_delivery_approval"], ["delivered", "awaiting_producer_review"]]);
const now = () => new Date().toISOString();
const queueDir = (root) => path.join(path.resolve(root), ".queue");
const lockFile = (root) => path.join(queueDir(root), "worker.lock");

export function resolveQueuedRun(root, runId) {
  if (typeof runId !== "string" || !runId || [".", ".."].includes(runId) || /[\\/\0]/u.test(runId)) throw new Error("run ID must be one directory name inside runs");
  return path.join(path.resolve(root), "runs", runId);
}

function manifest(root, runId) {
  return JSON.parse(fs.readFileSync(path.join(resolveQueuedRun(root, runId), "manifest.json"), "utf8"));
}

function jobFile(root, runId) {
  resolveQueuedRun(root, runId);
  return path.join(queueDir(root), "jobs", `${runId}.json`);
}

function writeJob(root, job) {
  const file = jobFile(root, job.runId), temporary = `${file}.${process.pid}.tmp`;
  job.updatedAt = now();
  fs.writeFileSync(temporary, `${JSON.stringify(job, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
  return job;
}

function readJobs(root) {
  const directory = path.join(queueDir(root), "jobs");
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(fs.readFileSync(path.join(directory, name), "utf8")))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.runId.localeCompare(b.runId));
}

function ownerStatus(owner) {
  if (!Number.isSafeInteger(owner?.pid) || owner.pid <= 0) return "unknown";
  try { process.kill(owner.pid, 0); return "running"; }
  catch (error) { if (error.code === "ESRCH") return "exited"; if (error.code === "EPERM") return "running"; return "unknown"; }
}

function readLock(file) {
  if (!fs.existsSync(file)) return null;
  try {
    const owner = JSON.parse(fs.readFileSync(file, "utf8"));
    return { file, ...owner, ownerStatus: ownerStatus(owner) };
  } catch { return { file, ownerStatus: "unknown" }; }
}

function acquireWorker(root) {
  fs.mkdirSync(queueDir(root), { recursive: true, mode: 0o700 });
  const file = lockFile(root), owner = { pid: process.pid, startedAt: now() };
  try {
    const handle = fs.openSync(file, "wx", 0o600);
    fs.writeFileSync(handle, `${JSON.stringify(owner)}\n`);
    fs.closeSync(handle);
    return { acquired: true, owner };
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    return { acquired: false, owner: readLock(file) };
  }
}

function releaseWorker(root) {
  fs.unlinkSync(lockFile(root));
}

export function enqueueJob(root, runId) {
  const current = manifest(root, runId), file = jobFile(root, runId);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const timestamp = now();
  const job = { runId, state: "queued", manifestState: current.state, createdAt: timestamp, updatedAt: timestamp, attempts: 0, error: null };
  try { fs.writeFileSync(file, `${JSON.stringify(job, null, 2)}\n`, { flag: "wx", mode: 0o600 }); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    return { enqueued: false, job: JSON.parse(fs.readFileSync(file, "utf8")) };
  }
  return { enqueued: true, job };
}

export function queueStatus(root) {
  return { root: path.resolve(root), worker: readLock(lockFile(root)), jobs: readJobs(root) };
}

export function retryJob(root, runId) {
  const file = jobFile(root, runId);
  if (!fs.existsSync(file)) throw new Error("run is not enqueued");
  // An explicit retry can recover an exited worker, but never removes a run lock.
  const previousLock = readLock(lockFile(root));
  if (previousLock?.ownerStatus === "exited") fs.unlinkSync(lockFile(root));
  const lock = acquireWorker(root);
  if (!lock.acquired) return { retried: false, busy: true, owner: lock.owner };
  try {
    const job = JSON.parse(fs.readFileSync(file, "utf8"));
    if (job.state === "running" && !previousLock) throw new Error("running job has no worker owner; inspect its run lock before retrying");
    if (!["failed", "stopped", "waiting_for_run_lock", "running"].includes(job.state)) throw new Error(`retry requires failed, stopped, or interrupted work; got ${job.state}`);
    job.manifestState = manifest(root, runId).state;
    job.state = "queued";
    job.error = null;
    delete job.lockOwner;
    writeJob(root, job);
    return { retried: true, job };
  } finally { releaseWorker(root); }
}

function classify(job, current) {
  job.manifestState = current.state;
  job.error = null;
  delete job.lockOwner;
  if (PAUSED.has(current.state)) { job.state = PAUSED.get(current.state); return null; }
  if (["draft", "planning"].includes(current.state)) { job.state = "queued"; return "plan"; }
  if (["screenplay_repairing", "storyboard_repairing"].includes(current.state)) { job.state = "queued"; return "repair"; }
  if (RUNNABLE.has(current.state)) { job.state = "queued"; return "run"; }
  job.state = "stopped";
  job.error = `run cannot continue from ${current.state}`;
  return null;
}

async function executeCli({ root, runId, action, env }) {
  if (!env.PI_CODING_AGENT_DIR?.trim()) throw new Error("PI_CODING_AGENT_DIR must explicitly select company credentials before generation");
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, "bin", "tianshu.mjs"), action, runId], { cwd: root, env, stdio: ["ignore", "ignore", "inherit"] });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

export async function runWorkerOnce(root, { execute = executeCli, env = process.env } = {}) {
  root = path.resolve(root);
  const lock = acquireWorker(root);
  if (!lock.acquired) return { busy: true, owner: lock.owner, action: "inspect the exact worker owner; explicit retry is required after an exited worker" };
  try {
    for (const job of readJobs(root)) {
      if (["failed", "stopped", "awaiting_producer_review"].includes(job.state)) continue;
      if (job.state === "running") {
        job.state = "failed";
        job.error = "worker ended before recording a result; usage may be unknown; explicit retry required";
        writeJob(root, job);
        continue;
      }
      let action;
      try { action = classify(job, manifest(root, job.runId)); }
      catch (error) { job.state = "failed"; job.error = error.message; }
      writeJob(root, job);
      if (!action) continue;
      const runLock = readLock(path.join(resolveQueuedRun(root, job.runId), ".lock"));
      if (runLock) {
        job.state = "waiting_for_run_lock";
        job.lockOwner = runLock;
        job.error = "run lock is preserved; use lock-status and the existing unlock-stale procedure";
        writeJob(root, job);
        continue;
      }
      if (execute === executeCli && !env.PI_CODING_AGENT_DIR?.trim()) {
        job.state = "failed";
        job.error = "PI_CODING_AGENT_DIR must explicitly select company credentials before generation";
        writeJob(root, job);
        return { processed: false, job };
      }
      job.state = "running";
      job.startedAt = now();
      job.attempts += 1;
      writeJob(root, job);
      try {
        // Manual review leaves passed tasks intact until repair marks its targets stale.
        for (const command of action === "repair" ? ["repair", "run"] : [action]) {
          const result = await execute({ root, runId: job.runId, action: command, env });
          if (result?.code !== 0) throw new Error(`CLI ${command} failed (${result?.signal || `exit ${result?.code ?? "unknown"}`}); no automatic retry`);
        }
        const next = classify(job, manifest(root, job.runId));
        if (next) {
          job.state = "failed";
          job.error = `CLI ${action} returned without reaching a handoff state (${job.manifestState}); explicit retry required`;
        }
      } catch (error) {
        job.state = "failed";
        job.error = error.message;
      }
      job.finishedAt = now();
      writeJob(root, job);
      return { processed: true, action, job };
    }
    return { processed: false, jobs: readJobs(root) };
  } finally { releaseWorker(root); }
}
