#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createRun, loadManifest, markdownDelivery, readText, runRoot, saveManifest, transition, writeJson, writeText } from "../src/core.mjs";
import { applyRepair, plan, produceScripts, produceStoryboards, reviewScripts, reviewStoryboards } from "../src/agents.mjs";
import { clearStaleRunLock, deliveryGate, readRunLock, runProduction, withRunLock } from "../src/runtime.mjs";
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const [cmd,...args]=process.argv.slice(2);
const findRun=(id)=>path.join(runRoot(ROOT),id);
const help=()=>console.log("tianshu init <input> [--title T] [--episodes 30|60] [--contract production-contract.json] | plan <run> | status <run> | approve <run> | run <run> | resume <run> | produce <run> | review <run> | repair <run> | storyboard <run> | storyboard-review <run> | approve-delivery <run> | return <run> <note> | deliver <run> | lock-status <run> | unlock-stale <run>");
const flag=(name)=>{const i=args.indexOf(name);return i>=0?args[i+1]:null;};
const mutateRun=(id,operation)=>{const d=findRun(id);return withRunLock(d,()=>operation(d));};
async function deliverUnlocked(d){const m=loadManifest(d);if(m.state!=="ready_to_deliver")throw new Error(`cannot deliver from ${m.state}`);const readiness=deliveryGate(d);const md=markdownDelivery(d);const out=path.join(d,"deliverables",`${m.title}｜分镜剧本.md`);const docx=path.join(d,"deliverables",`${m.title}｜分镜剧本.docx`);writeText(out,md);execFileSync(process.env.TIANSHU_PYTHON||"python3",[path.join(ROOT,"src","experiments","render_storyboard_docx.py"),out,docx]);if(!fs.existsSync(docx)||fs.statSync(docx).size<1000)throw new Error("DOCX render failed");writeJson(path.join(d,"delivery.json"),{markdown:out,docx,digest:(await import("../src/core.mjs")).sha(md),readiness});return transition(d,"delivered","Markdown and DOCX delivery generated after fresh delivery gate");}
try { if(cmd==="init"){const input=readText(args[0]);const title=flag("--title")||input.split("\n")[0].slice(0,50);const contractFile=flag("--contract"),productionContract=contractFile?JSON.parse(readText(contractFile)):undefined;const {id}=createRun(ROOT,{title,episodes:flag("--episodes")||30,input,...(productionContract?{productionContract}:{})});console.log(JSON.stringify({id,state:"draft"}));}
else if(cmd==="status"){console.log(JSON.stringify(loadManifest(findRun(args[0])),null,2));}
else if(cmd==="lock-status"){console.log(JSON.stringify(readRunLock(findRun(args[0])),null,2));}
else if(cmd==="unlock-stale"){console.log(JSON.stringify(clearStaleRunLock(findRun(args[0])),null,2));}
else if(cmd==="approve"){console.log(JSON.stringify(await mutateRun(args[0],async(d)=>{const m=loadManifest(d);if(m.state!=="awaiting_approval")throw new Error(`cannot approve from ${m.state}`);return transition(d,"approved","human phase-A approval");})));}
else if(cmd==="plan"){console.log(JSON.stringify(await mutateRun(args[0],async(d)=>{await plan(d);return loadManifest(d);})));}
else if(cmd==="produce"){console.log(JSON.stringify(await mutateRun(args[0],async(d)=>{await produceScripts(d);return loadManifest(d);})));}
else if(cmd==="review"){console.log(JSON.stringify(await mutateRun(args[0],reviewScripts)));}
else if(cmd==="repair"){console.log(JSON.stringify(await mutateRun(args[0],async(d)=>applyRepair(d))));}
else if(cmd==="run"||cmd==="resume"){const d=findRun(args[0]);await withRunLock(d,async()=>{await runProduction(d,undefined,{lock:false});if(loadManifest(d).state==="ready_to_deliver")await deliverUnlocked(d);});console.log(JSON.stringify(loadManifest(d)));}
else if(cmd==="storyboard"){console.log(JSON.stringify(await mutateRun(args[0],async(d)=>{await produceStoryboards(d);return loadManifest(d);})));}
else if(cmd==="storyboard-review"){console.log(JSON.stringify(await mutateRun(args[0],reviewStoryboards)));}
else if(cmd==="approve-delivery"){console.log(JSON.stringify(await mutateRun(args[0],async(d)=>{const m=loadManifest(d);if(m.state!=="awaiting_delivery_approval")throw new Error(`cannot approve delivery from ${m.state}`);return transition(d,"ready_to_deliver","human final delivery approval");})));}
else if(cmd==="return"){console.log(JSON.stringify(await mutateRun(args[0],async(d)=>transition(d,"returned",args.slice(1).join(" ")))));}
else if(cmd==="deliver"){const d=findRun(args[0]);console.log(JSON.stringify(await withRunLock(d,()=>deliverUnlocked(d))));}
else help(); } catch(e){console.error(`error: ${e.message}`);process.exitCode=1;}
