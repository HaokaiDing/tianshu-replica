import fs from "node:fs";
import path from "node:path";
import { Type, createPiExperimentSession, defineTool, promptWithWatchdog, readText, sha, writeJson, writeText } from "./experiments/lib.mjs";
import { STORYBOARD_HEADER, checkStoryboard, loadManifest, saveManifest, taskPath } from "./core.mjs";
import { markStale, repairPlan } from "./review.mjs";

const ep = (n) => String(n).padStart(2, "0");
const batches = (total) => Array.from({length:Math.ceil(total/5)},(_,i)=>({from:i*5+1,to:Math.min(total,i*5+5)}));
export async function plan(runDir) {
  const m=loadManifest(runDir), input=readText(path.join(runDir,"canonical","input.md")); let accepted=false;
  const submit=defineTool({name:"submit_planning_bundle",label:"Submit planning",description:"Submit a complete planning bundle with exactly the requested number of numbered episode outlines.",parameters:Type.Object({acts:Type.String({minLength:100}),design:Type.String({minLength:100}),characters:Type.String({minLength:100}),ledger:Type.Object({names:Type.Array(Type.String(),{minItems:2}),facts:Type.Array(Type.String(),{minItems:3})}),outline:Type.Array(Type.String({minLength:40}),{minItems:m.episodes,maxItems:m.episodes})}),async execute(_id,p){writeText(path.join(runDir,"canonical","acts.md"),p.acts);writeText(path.join(runDir,"canonical","design.md"),p.design);writeText(path.join(runDir,"canonical","characters.md"),p.characters);writeJson(path.join(runDir,"canonical","ledger.json"),p.ledger);writeText(path.join(runDir,"canonical","outline.md"),p.outline.map((x,i)=>`## 第${i+1}集\n${x}`).join("\n\n"));accepted=true;return {content:[{type:"text",text:"ACCEPTED planning"}],details:{},terminate:true};}});
  const {session,metrics}=await createPiExperimentSession({runDir,role:"planner",systemPrompt:`You are Tianshu Planner. Create a strong ${m.episodes}-episode vertical-drama plan from the brief. Use one emotion engine, concrete hooks, active heroine, no police/court/DNA/surveillance shortcuts. Submit only through the tool.`,customTools:[submit],toolNames:["submit_planning_bundle"]});
  try{await promptWithWatchdog(session,metrics,`Brief:\n${input}`);if(!accepted)throw new Error("planner did not submit");m.state="awaiting_approval";m.planMetrics=metrics;saveManifest(runDir,m);return metrics;}finally{session.dispose();}
}
export async function produceScripts(runDir) {
  const m=loadManifest(runDir);if(m.state!=="approved")throw new Error(`produce requires approved, got ${m.state}`);const outline=readText(path.join(runDir,"canonical","outline.md")),chars=readText(path.join(runDir,"canonical","characters.md")),ledger=readText(path.join(runDir,"canonical","ledger.json"));m.state="screenplay_producing";saveManifest(runDir,m);
  for(const b of batches(m.episodes)){let active={episode:b.from};const submit=defineTool({name:"submit_screenplay",label:"Submit screenplay",description:"Submit one screenplay for the currently requested episode.",parameters:Type.Object({episode:Type.Integer(),markdown:Type.String({minLength:700})}),async execute(_id,p){if(p.episode!==active.episode)return {content:[{type:"text",text:"REJECTED wrong episode"}],details:{},terminate:false};if(!/【本集钩子】/.test(p.markdown)||!/【连续性检查】/.test(p.markdown))return {content:[{type:"text",text:"REJECTED missing hook or continuity"}],details:{},terminate:false};writeText(path.join(runDir,"screenplay",`ep-${ep(p.episode)}.md`),p.markdown);writeJson(path.join(runDir,"continuity",`ep-${ep(p.episode)}.json`),{episode:p.episode,digest:sha(p.markdown),hook:p.markdown.match(/【本集钩子】[^\n]*/)?.[0]||""});writeJson(taskPath(runDir,`screenplay-ep-${ep(p.episode)}`),{state:"passed",digest:sha(p.markdown)});return {content:[{type:"text",text:"ACCEPTED"}],details:{},terminate:true};}});
    const {session}=await createPiExperimentSession({runDir,role:`writer-${b.from}-${b.to}`,systemPrompt:"You are a Tianshu Writer. Produce one requested bilingual screenplay at a time. Read the injected plan and continuity; preserve names and facts. Submit through tool only.",customTools:[submit],toolNames:["submit_screenplay"]});
    try{for(let n=b.from;n<=b.to;n++){active.episode=n;const prev=n>1&&fs.existsSync(path.join(runDir,"continuity",`ep-${ep(n-1)}.json`))?readText(path.join(runDir,"continuity",`ep-${ep(n-1)}.json`)):"start";await promptWithWatchdog(session,{prompts:0,turns:0,toolCalls:0,compactions:0,usage:[],events:[]},`Episode ${n}.\nPlan:\n${outline}\nCharacters:${chars}\nLedger:${ledger}\nPrevious continuity:${prev}`);}}finally{session.dispose();}}
  m.state="screenplay_review";saveManifest(runDir,m);
}
export async function produceStoryboards(runDir) {
  const m=loadManifest(runDir);if(m.state!=="screenplay_review")throw new Error(`storyboard requires screenplay_review, got ${m.state}`);m.state="storyboard_producing";saveManifest(runDir,m);
  for(const b of batches(m.episodes)){let active={episode:b.from};const submit=defineTool({name:"submit_storyboard",label:"Submit storyboard",description:"Submit a fixed 11-column storyboard for the current episode.",parameters:Type.Object({episode:Type.Integer(),markdown:Type.String({minLength:500})}),async execute(_id,p){const errors=p.episode===active.episode?checkStoryboard(p.markdown):["wrong episode"];if(errors.length)return {content:[{type:"text",text:`REJECTED ${errors.join("; ")}`}],details:{errors},terminate:false};writeText(path.join(runDir,"storyboard",`ep-${ep(p.episode)}.md`),p.markdown);writeJson(taskPath(runDir,`storyboard-ep-${ep(p.episode)}`),{state:"passed",digest:sha(p.markdown)});return {content:[{type:"text",text:"ACCEPTED"}],details:{},terminate:true};}});
    const {session}=await createPiExperimentSession({runDir,role:`storyboard-${b.from}-${b.to}`,systemPrompt:`You are a Tianshu Storyboard Director. Produce exactly this header: | ${STORYBOARD_HEADER.join(" | ")} |. 12-20 shots, each 3-7 sec, total 55-95 sec. Submit only through tool.`,customTools:[submit],toolNames:["submit_storyboard"]});
    try{for(let n=b.from;n<=b.to;n++){active.episode=n;await promptWithWatchdog(session,{prompts:0,turns:0,toolCalls:0,compactions:0,usage:[],events:[]},`Episode ${n} screenplay:\n${readText(path.join(runDir,"screenplay",`ep-${ep(n)}.md`))}`);}}finally{session.dispose();}}
  m.state="awaiting_delivery_approval";saveManifest(runDir,m);
}

export async function reviewScripts(runDir) {
  const m=loadManifest(runDir);if(m.state!=="screenplay_review")throw new Error(`review requires screenplay_review, got ${m.state}`);
  const findings=[];
  for(const b of batches(m.episodes)){
    const submit=defineTool({name:"submit_review",label:"Submit review",description:"Submit findings for this screenplay window.",parameters:Type.Object({findings:Type.Array(Type.Object({episode:Type.Integer(),severity:Type.Union([Type.Literal('P0'),Type.Literal('P1'),Type.Literal('P2')]),scope:Type.Union([Type.Literal('local'),Type.Literal('pair'),Type.Literal('upstream')]),reason:Type.String()}))}),async execute(_id,p){for(const f of p.findings)if(f.episode<b.from||f.episode>b.to)return {content:[{type:'text',text:'REJECTED finding outside review window'}],details:{},terminate:false};findings.push(...p.findings);return {content:[{type:'text',text:'ACCEPTED review'}],details:{},terminate:true};}});
    const scripts=[];for(let n=b.from;n<=b.to;n++)scripts.push(`EP${n}\n${readText(path.join(runDir,'screenplay',`ep-${ep(n)}.md`))}`);
    const {session}=await createPiExperimentSession({runDir,role:`reviewer-${b.from}-${b.to}`,systemPrompt:"You are a strict short-drama reviewer. Only report real P0/P1/P2 defects with episode numbers. P0 means upstream/systemic, P1 needs repair, P2 is a note. Submit through the tool.",customTools:[submit],toolNames:['submit_review']});
    try{await promptWithWatchdog(session,{prompts:0,turns:0,toolCalls:0,compactions:0,usage:[],events:[]},scripts.join('\n\n'));}finally{session.dispose();}
  }
  writeJson(path.join(runDir,'reviews','screenplay.json'),{findings});
  const plan=repairPlan(findings,m.episodes);writeJson(path.join(runDir,'reviews','repair-plan.json'),plan);
  if(plan.action==='blocked'){m.state='blocked';m.note='review requires human decision';}
  else if(plan.action==='repair'){m.state='blocked';m.note='run tianshu repair after reviewing repair-plan.json';}
  else m.state='screenplay_review';
  saveManifest(runDir,m);return plan;
}

export function applyRepair(runDir) {
  const m=loadManifest(runDir);const plan=JSON.parse(readText(path.join(runDir,'reviews','repair-plan.json')));
  if(plan.action!=='repair')throw new Error(`repair plan action is ${plan.action}`);
  const stale=markStale(runDir,plan.episodes);m.state='screenplay_producing';m.note=`repair requested for ${plan.episodes.join(',')}`;saveManifest(runDir,m);return {plan,stale};
}
