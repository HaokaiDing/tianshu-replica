#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { enqueueJob, queueStatus, retryJob, runWorkerOnce } from "../src/queue.mjs";

const args = process.argv.slice(2);
const rootIndex = args.indexOf("--root");
let root = process.env.TIANSHU_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
try {
  if (rootIndex >= 0) {
    if (!args[rootIndex + 1] || args[rootIndex + 1].startsWith("--")) throw new Error("--root requires a project directory");
    root = path.resolve(args[rootIndex + 1]);
    args.splice(rootIndex, 2);
  }
  const [command, runId] = args;
  let result;
  if (command === "enqueue" && args.length === 2) result = enqueueJob(root, runId);
  else if (command === "retry" && args.length === 2) result = retryJob(root, runId);
  else if (command === "once" && args.length === 1) result = await runWorkerOnce(root);
  else if (command === "status" && args.length === 1) result = queueStatus(root);
  else throw new Error("usage: tianshu-worker [--root project] enqueue <run-id> | once | retry <run-id> | status");
  console.log(JSON.stringify(result, null, 2));
  if (result.job?.state === "failed") process.exitCode = 1;
} catch (error) {
  console.error(`error: ${error.message}`);
  process.exitCode = 1;
}
