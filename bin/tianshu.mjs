#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createRun, loadManifest, markdownDelivery, readText, runRoot, saveManifest, transition, writeJson, writeText } from "../src/core.mjs";
import { applyRepair, plan, produceScripts, produceStoryboards, reviewScripts } from "../src/agents.mjs";
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const [cmd,...args]=process.argv.slice(2);
const findRun=(id)=>path.join(runRoot(ROOT),id);
const help=()=>console.log("tianshu init <input> [--title T] [--episodes 30|60] | plan <run> | status <run> | approve <run> | produce <run> | review <run> | repair <run> | resume <run> | storyboard <run> | approve-delivery <run> | return <run> <note> | deliver <run>");
const flag=(name)=>{const i=args.indexOf(name);return i>=0?args[i+1]:null;};
try { if(cmd==="init"){const input=readText(args[0]);const title=flag("--title")||input.split("\n")[0].slice(0,50);const {id}=createRun(ROOT,{title,episodes:flag("--episodes")||30,input});console.log(JSON.stringify({id,state:"draft"}));}
else if(cmd==="status"){console.log(JSON.stringify(loadManifest(findRun(args[0])),null,2));}
else if(cmd==="approve"){const d=findRun(args[0]);const m=loadManifest(d);if(m.state!=="awaiting_approval"&&m.state!=="draft")throw new Error(`cannot approve from ${m.state}`);console.log(JSON.stringify(transition(d,"approved","human phase-A approval")));}
else if(cmd==="plan"){await plan(findRun(args[0]));console.log(JSON.stringify(loadManifest(findRun(args[0]))));}
else if(cmd==="produce"){await produceScripts(findRun(args[0]));console.log(JSON.stringify(loadManifest(findRun(args[0]))));}
else if(cmd==="review"){console.log(JSON.stringify(await reviewScripts(findRun(args[0]))));}
else if(cmd==="repair"){console.log(JSON.stringify(applyRepair(findRun(args[0]))));}
else if(cmd==="resume"){const d=findRun(args[0]);const m=loadManifest(d);if(m.state==="screenplay_producing"){await produceScripts(d);console.log(JSON.stringify(loadManifest(d)));}else if(m.state==="storyboard_producing"){await produceStoryboards(d);console.log(JSON.stringify(loadManifest(d)));}else throw new Error(`nothing resumable from ${m.state}`);}
else if(cmd==="storyboard"){await produceStoryboards(findRun(args[0]));console.log(JSON.stringify(loadManifest(findRun(args[0]))));}
else if(cmd==="approve-delivery"){const d=findRun(args[0]);const m=loadManifest(d);if(m.state!=="awaiting_delivery_approval")throw new Error(`cannot approve delivery from ${m.state}`);console.log(JSON.stringify(transition(d,"ready_to_deliver","human final delivery approval")));}
else if(cmd==="return"){console.log(JSON.stringify(transition(findRun(args[0]),"returned",args.slice(1).join(" "))));}
else if(cmd==="deliver"){const d=findRun(args[0]);const m=loadManifest(d);if(m.state!=="ready_to_deliver")throw new Error(`cannot deliver from ${m.state}`);const md=markdownDelivery(d);const out=path.join(d,"deliverables",`${m.title}｜分镜剧本.md`);const docx=path.join(d,"deliverables",`${m.title}｜分镜剧本.docx`);writeText(out,md);execFileSync(process.env.TIANSHU_PYTHON||"python3",[path.join(ROOT,"src","experiments","render_storyboard_docx.py"),out,docx]);if(!fs.existsSync(docx)||fs.statSync(docx).size<1000)throw new Error("DOCX render failed");writeJson(path.join(d,"delivery.json"),{markdown:out,docx,digest:(await import("../src/core.mjs")).sha(md)});console.log(JSON.stringify(transition(d,"delivered","Markdown and DOCX delivery generated")));}
else help(); } catch(e){console.error(`error: ${e.message}`);process.exitCode=1;}
