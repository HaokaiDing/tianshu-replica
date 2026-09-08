#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// Local dependency inspection only: no ModelRuntime, login, refresh, or HTTP call.
const root = fileURLToPath(new URL("../", import.meta.url));
const [major, minor] = process.versions.node.split(".").map(Number);
const sdkFile = path.join(root, "node_modules", "@earendil-works", "pi-coding-agent", "package.json");
const sdk = fs.existsSync(sdkFile) ? JSON.parse(fs.readFileSync(sdkFile, "utf8")) : null;
const python = process.env.TIANSHU_PYTHON || "python3";
const docx = spawnSync(python, ["-c", "import docx; print(docx.__version__)"], { encoding: "utf8", timeout: 10_000 });
const authDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
const checks = {
  node: { version: process.versions.node, ok: major > 22 || (major === 22 && minor >= 19) },
  piSdk: { version: sdk?.version ?? null, ok: sdk?.version === "0.84.2" },
  docx: { python, version: docx.status === 0 ? docx.stdout.trim() : null, ok: docx.status === 0 },
};
const disk = fs.statfsSync(root);
const result = {
  ok: Object.values(checks).every((check) => check.ok),
  scope: "offline dependency check; not production or account acceptance",
  platform: `${process.platform}/${process.arch}`,
  checks,
  freeDiskBytes: disk.bavail * disk.bsize,
  credentials: { directory: authDir, authFileExists: fs.existsSync(path.join(authDir, "auth.json")), accountIdentity: "not inspected", modelRequestSent: false },
};
console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;
