import fs from "node:fs";
import path from "node:path";
import { Type, createPiExperimentSession, defineTool, promptWithWatchdog, readText, sha, writeJson, writeText } from "./experiments/lib.mjs";
import { STORYBOARD_HEADER, checkStoryboard, loadManifest, saveManifest, taskPath } from "./core.mjs";
import { markStale, repairPlan } from "./review.mjs";
import { inferMarketIntent, marketChecks, marketContractMarkdown, validateMarketSubmission } from "./market.mjs";

const ep = (n) => String(n).padStart(2, "0");
const batches = (total) => Array.from({length:Math.ceil(total/5)},(_,i)=>({from:i*5+1,to:Math.min(total,i*5+5)}));
function outlineWindow(outline, episode, total) {
  const parts = outline.split(/(?=^## 第\d+集)/m);
  const wanted = new Set([episode - 1, episode, episode + 1].filter((n) => n >= 1 && n <= total));
  return parts.filter((part) => wanted.has(Number(part.match(/^## 第(\d+)集/m)?.[1]))).join("\n\n");
}
function artifactTools(runDir, workDir) {
  const roots=['canonical','screenplay','storyboard','continuity','reviews','research'];
  const read=defineTool({name:'read_artifact',label:'Read artifact',description:'Read an approved project artifact by relative path.',parameters:Type.Object({ref:Type.String()}),async execute(_id,p){const f=path.resolve(runDir,p.ref);if(!roots.some(r=>f.startsWith(path.join(runDir,r)+path.sep))||!fs.existsSync(f))return {content:[{type:'text',text:'REJECTED artifact unavailable'}],details:{},terminate:false};return {content:[{type:'text',text:readText(f).slice(0,12000)}],details:{ref:p.ref,digest:sha(readText(f))}};}});
  const write=defineTool({name:'write_draft',label:'Write draft',description:'Write the complete current-episode draft only inside this task workspace. This is not the final submission.',parameters:Type.Object({markdown:Type.String({minLength:700})}),async execute(_id,p){writeText(path.join(workDir,'draft.md'),p.markdown);return {content:[{type:'text',text:'draft saved; run checks next'}],details:{}};}});
  return [read,write];
}
function writeBatchMetrics(runDir, role, metrics, outcome, extra = {}) {
  const endedAt = new Date().toISOString();
  const usage = metrics.usage.reduce((sum, item) => ({
    input: sum.input + (item.input || 0), output: sum.output + (item.output || 0),
    cacheRead: sum.cacheRead + (item.cacheRead || 0), cacheWrite: sum.cacheWrite + (item.cacheWrite || 0),
    totalTokens: sum.totalTokens + (item.totalTokens || 0),
  }), {input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0});
  const file = path.join(runDir, 'metrics', `${role}.json`);
  const record = { role, outcome, endedAt, ...metrics, usageTotal:usage, ...extra };
  const previous = fs.existsSync(file) ? JSON.parse(readText(file)) : null;
  const previousAttempts = previous ? (previous.attempts || [{ ...previous, attempts: undefined }]) : [];
  writeJson(file, { ...record, attempts: [...previousAttempts, record] });
}
function screenplayChecks(markdown, episode, market) {
  const failures=[];
  if (markdown.length < 700) failures.push('剧本过短');
  if (!/【本集钩子】/.test(markdown)) failures.push('缺少【本集钩子】');
  if (!/【连续性检查】/.test(markdown)) failures.push('缺少【连续性检查】');
  if (!/(?:EN|英)\s*[:：]|^[A-Za-z][A-Za-z .'-]{1,40}[:：]|\/\s*[A-Za-z][A-Za-z .,'"'!?—-]{4,}/m.test(markdown)) failures.push('缺少英文台词');
  if (!new RegExp(`(?:第?${episode}集|EP(?:ISODE)?\\s*${episode})`, 'i').test(markdown)) failures.push('缺少本集标识');
  return [...failures, ...marketChecks(markdown, market)];
}
export async function plan(runDir) {
  const m=loadManifest(runDir), input=readText(path.join(runDir,"canonical","input.md")), intent=inferMarketIntent(input); let accepted=false;
  const submit=defineTool({name:"submit_planning_bundle",label:"Submit planning",description:"Submit a complete planning bundle with an explicit target-market contract and exactly the requested number of numbered episode outlines.",parameters:Type.Object({market:Type.Object({country:Type.String(),setting:Type.String({minLength:20}),characterNaming:Type.String({minLength:20}),socialContext:Type.String({minLength:20}),culturalAnchors:Type.Array(Type.String({minLength:2}),{minItems:2})}),acts:Type.String({minLength:100}),design:Type.String({minLength:100}),characters:Type.String({minLength:100}),ledger:Type.Object({names:Type.Array(Type.String(),{minItems:2}),facts:Type.Array(Type.String(),{minItems:3})}),outline:Type.Array(Type.String({minLength:40}),{minItems:m.episodes,maxItems:m.episodes})}),async execute(_id,p){const errors=validateMarketSubmission(intent,p.market);if(errors.length)return {content:[{type:'text',text:`REJECTED ${errors.join('；')}`}],details:{errors},terminate:false};const contract={...intent,...p.market};writeJson(path.join(runDir,"canonical","market.json"),contract);writeText(path.join(runDir,"canonical","market-contract.md"),marketContractMarkdown(contract));writeText(path.join(runDir,"canonical","acts.md"),p.acts);writeText(path.join(runDir,"canonical","design.md"),p.design);writeText(path.join(runDir,"canonical","characters.md"),p.characters);writeJson(path.join(runDir,"canonical","ledger.json"),p.ledger);writeText(path.join(runDir,"canonical","outline.md"),p.outline.map((x,i)=>`## 第${i+1}集\n${x}`).join("\n\n"));accepted=true;return {content:[{type:"text",text:"ACCEPTED planning and market contract"}],details:{},terminate:true};}});
  const {session,metrics}=await createPiExperimentSession({runDir,role:"planner",systemPrompt:`You are Tianshu Planner. Create a strong ${m.episodes}-episode vertical-drama plan from the brief. Use one emotion engine, concrete hooks, active heroine, no police/court/DNA/surveillance shortcuts. The target market is a hard creative constraint: set every character name, city, institution, family structure, money/legal context, props and cultural reference in that country. Do not use Chinese names or Chinese social settings for a US story merely because the production language is Chinese. Submit only through the tool.`,customTools:[submit],toolNames:["submit_planning_bundle"]});
  try{await promptWithWatchdog(session,metrics,`Brief:\n${input}\n\nNon-negotiable market intent:\n${marketContractMarkdown(intent)}`);if(!accepted)throw new Error("planner did not submit");m.state="awaiting_approval";m.planMetrics=metrics;saveManifest(runDir,m);return metrics;}finally{session.dispose();}
}
export async function produceScripts(runDir) {
  const m=loadManifest(runDir);if(!["approved","screenplay_producing"].includes(m.state))throw new Error(`produce requires approved or screenplay_producing, got ${m.state}`);const outline=readText(path.join(runDir,"canonical","outline.md")),chars=readText(path.join(runDir,"canonical","characters.md")),ledger=readText(path.join(runDir,"canonical","ledger.json")),market=JSON.parse(readText(path.join(runDir,"canonical","market.json"))),marketContract=readText(path.join(runDir,"canonical","market-contract.md"));m.state="screenplay_producing";saveManifest(runDir,m);
  for(const b of batches(m.episodes)){let active={episode:b.from};const workDir=path.join(runDir,'work',`writer-${b.from}-${b.to}`);let lastChecks=[];
    const runChecks=defineTool({name:'run_checks',label:'Check screenplay',description:'Validate the draft for the current episode before submission, including the target-market contract.',parameters:Type.Object({}),async execute(){const draft=path.join(workDir,'draft.md');if(!fs.existsSync(draft))lastChecks=['尚未写入草稿'];else lastChecks=screenplayChecks(readText(draft),active.episode,market);return {content:[{type:'text',text:lastChecks.length?`FAIL: ${lastChecks.join('；')}`:'PASS: draft is eligible for submission'}],details:{failures:lastChecks},terminate:false};}});
    const submit=defineTool({name:"submit_screenplay",label:"Submit screenplay",description:"Submit the checked draft for the current episode. The tool reads the saved draft; never paste a screenplay into this call.",parameters:Type.Object({episode:Type.Integer()}),async execute(_id,p){if(p.episode!==active.episode)return {content:[{type:"text",text:"REJECTED wrong episode"}],details:{},terminate:false};const draft=path.join(workDir,'draft.md');if(!fs.existsSync(draft))return {content:[{type:'text',text:'REJECTED no draft'}],details:{},terminate:false};const markdown=readText(draft), errors=screenplayChecks(markdown,p.episode,market);if(errors.length)return {content:[{type:'text',text:`REJECTED ${errors.join('；')}`}],details:{errors},terminate:false};writeText(path.join(runDir,"screenplay",`ep-${ep(p.episode)}.md`),markdown);writeJson(path.join(runDir,"continuity",`ep-${ep(p.episode)}.json`),{episode:p.episode,digest:sha(markdown),hook:markdown.match(/【本集钩子】[^\n]*/)?.[0]||""});writeJson(taskPath(runDir,`screenplay-ep-${ep(p.episode)}`),{state:"passed",digest:sha(markdown)});return {content:[{type:"text",text:"ACCEPTED screenplay"}],details:{},terminate:true};}});
    const tools=artifactTools(runDir,workDir), role=`writer-${b.from}-${b.to}`;
    const {session,metrics}=await createPiExperimentSession({runDir,role,systemPrompt:"你是天书剧本作者，一次只做指定的一集。每次任务必须严格走三步：1) 用 write_draft 写完整剧本；2) 调用 run_checks；3) 仅在收到 PASS 后调用 submit_screenplay 并传当前集数。submit 会读取草稿，绝不把剧本粘进 submit 参数。不要输出解释、不要停在半成品。你可在资料不够时使用 read_artifact。剧本须有中英双语对白、【本集钩子】和【连续性检查】。市场合同是硬约束：人物、空间、制度、道具和文化必须符合目标国家；不能因制作语言为中文而沿用中国姓名或社会语境。",customTools:[...tools,runChecks,submit],toolNames:["read_artifact","write_draft","run_checks","submit_screenplay"]});
    let outcome='completed'; try{for(let n=b.from;n<=b.to;n++){const task=taskPath(runDir,`screenplay-ep-${ep(n)}`);const artifact=path.join(runDir,"screenplay",`ep-${ep(n)}.md`);const prior=fs.existsSync(task)?JSON.parse(readText(task)):null;if(prior?.state==='passed'&&fs.existsSync(artifact))continue;active.episode=n;lastChecks=[];const prev=n>1&&fs.existsSync(path.join(runDir,"continuity",`ep-${ep(n-1)}.json`))?readText(path.join(runDir,"continuity",`ep-${ep(n-1)}.json`)):"start";const nearby=[n-1,n+1].filter(x=>x>=1&&x<=m.episodes).map(x=>{const f=path.join(runDir,'screenplay',`ep-${ep(x)}.md`);return fs.existsSync(f)?`第${x}集：\n${readText(f).slice(0,14000)}`:'';}).filter(Boolean).join('\n\n');const contractPath=path.join(runDir,'canonical','continuity-contract.md');const contract=fs.existsSync(contractPath)?readText(contractPath).slice(0,16000):'';const repair=prior?.repairInstruction?`\n这是修订任务。保留下面现有剧本的有效内容，只修复列出的缺陷。\n现有剧本：\n${fs.existsSync(artifact)?readText(artifact).slice(0,30000):''}\n修订要求：\n${prior.repairInstruction}`:"";await promptWithWatchdog(session,metrics,`只写第 ${n} 集，并按 write_draft → run_checks → submit_screenplay 的顺序调用工具。\n市场与文化合同（对新写和修订均强制生效）：\n${marketContract}\n\n硬连续性合同（对新写和修订均强制生效）：\n${contract}\n\n本集及相邻集大纲：\n${outlineWindow(outline,n,m.episodes)}\n人物：${chars.slice(0,12000)}\n台账：${ledger.slice(0,8000)}\n上一集连续性：${prev}\n相邻集上下文：\n${nearby}${repair}`,300000);if(!fs.existsSync(artifact))throw new Error(`writer did not submit episode ${n}`);}}catch(error){outcome='failed';writeBatchMetrics(runDir,role,metrics,outcome,{error:error.message});throw error;}finally{session.dispose();}writeBatchMetrics(runDir,role,metrics,outcome);}
  m.state="screenplay_review";saveManifest(runDir,m);
}
export async function produceStoryboards(runDir) {
  const m=loadManifest(runDir);if(m.state!=="screenplay_review")throw new Error(`storyboard requires screenplay_review, got ${m.state}`);const market=JSON.parse(readText(path.join(runDir,"canonical","market.json"))),marketContract=readText(path.join(runDir,"canonical","market-contract.md"));m.state="storyboard_producing";saveManifest(runDir,m);
  for(const b of batches(m.episodes)){let active={episode:b.from};const workDir=path.join(runDir,'work',`storyboard-${b.from}-${b.to}`);const runChecks=defineTool({name:'run_checks',label:'Check storyboard',description:'Validate the saved draft for the current episode before submission, including the target-market contract.',parameters:Type.Object({}),async execute(){const draft=path.join(workDir,'draft.md'),errors=fs.existsSync(draft)?[...checkStoryboard(readText(draft)),...marketChecks(readText(draft),market)]:['尚未写入草稿'];return {content:[{type:'text',text:errors.length?`FAIL: ${errors.join('；')}`:'PASS: storyboard is eligible for submission'}],details:{errors},terminate:false};}});const submit=defineTool({name:"submit_storyboard",label:"Submit storyboard",description:"Submit the checked saved draft. The tool reads the draft; never paste a storyboard into this call.",parameters:Type.Object({episode:Type.Integer()}),async execute(_id,p){const draft=path.join(workDir,'draft.md');const errors=p.episode===active.episode&&fs.existsSync(draft)?[...checkStoryboard(readText(draft)),...marketChecks(readText(draft),market)]:['wrong episode or missing draft'];if(errors.length)return {content:[{type:"text",text:`REJECTED ${errors.join("; ")}`}],details:{errors},terminate:false};const markdown=readText(draft);writeText(path.join(runDir,"storyboard",`ep-${ep(p.episode)}.md`),markdown);writeJson(taskPath(runDir,`storyboard-ep-${ep(p.episode)}`),{state:"passed",digest:sha(markdown)});return {content:[{type:"text",text:"ACCEPTED storyboard"}],details:{},terminate:true};}});
    const tools=artifactTools(runDir,workDir), role=`storyboard-${b.from}-${b.to}`;
    const {session,metrics}=await createPiExperimentSession({runDir,role,systemPrompt:`你是天书分镜导演。每次任务必须严格走三步：1) 用 write_draft 写完整分镜；2) 调用 run_checks；3) 只有 PASS 后调用 submit_storyboard 并传当前集数。submit 会读取草稿，绝不把分镜粘进 submit 参数。不要输出解释。表头必须是：| ${STORYBOARD_HEADER.join(" | ")} |。每集 12-20 镜、单镜 3-7 秒、总时长 55-95 秒。市场合同是硬约束：镜头中的人物、场景、道具、建筑、机构、服装和视觉提示必须属于目标国家，而非默认中国语境。`,customTools:[...tools,runChecks,submit],toolNames:["read_artifact","write_draft","run_checks","submit_storyboard"]});
    let outcome='completed';try{for(let n=b.from;n<=b.to;n++){const task=taskPath(runDir,`storyboard-ep-${ep(n)}`);const artifact=path.join(runDir,"storyboard",`ep-${ep(n)}.md`);const prior=fs.existsSync(task)?JSON.parse(readText(task)):null;if(prior?.state==='passed'&&fs.existsSync(artifact))continue;active.episode=n;await promptWithWatchdog(session,metrics,`只制作第 ${n} 集，按 write_draft → run_checks → submit_storyboard 的顺序调用工具。\n市场与文化合同：\n${marketContract}\n\n剧本：\n${readText(path.join(runDir,"screenplay",`ep-${ep(n)}.md`))}`,300000);if(!fs.existsSync(artifact))throw new Error(`storyboard agent did not submit episode ${n}`);}}catch(error){outcome='failed';writeBatchMetrics(runDir,role,metrics,outcome,{error:error.message});throw error;}finally{session.dispose();}writeBatchMetrics(runDir,role,metrics,outcome);}
  m.state="awaiting_delivery_approval";saveManifest(runDir,m);
}

export async function reviewScripts(runDir) {
  const m=loadManifest(runDir);if(m.state!=="screenplay_review")throw new Error(`review requires screenplay_review, got ${m.state}`);const market=JSON.parse(readText(path.join(runDir,"canonical","market.json"))),marketContract=readText(path.join(runDir,"canonical","market-contract.md"));
  const findings=[];
  for(const b of batches(m.episodes)){
    const submit=defineTool({name:"submit_review",label:"Submit review",description:"Submit findings for this screenplay window.",parameters:Type.Object({findings:Type.Array(Type.Object({episode:Type.Integer(),severity:Type.Union([Type.Literal('P0'),Type.Literal('P1'),Type.Literal('P2')]),scope:Type.Union([Type.Literal('local'),Type.Literal('pair'),Type.Literal('upstream')]),reason:Type.String()}))}),async execute(_id,p){for(const f of p.findings)if(f.episode<b.from||f.episode>b.to)return {content:[{type:'text',text:'REJECTED finding outside review window'}],details:{},terminate:false};findings.push(...p.findings);return {content:[{type:'text',text:'ACCEPTED review'}],details:{},terminate:true};}});
    const scripts=[];for(let n=b.from;n<=b.to;n++){const screenplay=readText(path.join(runDir,'screenplay',`ep-${ep(n)}.md`));for(const reason of marketChecks(screenplay,market))findings.push({episode:n,severity:'P1',scope:'local',reason:`market contract: ${reason}`});scripts.push(`EP${n}\n${screenplay}`);}
    const role=`reviewer-${b.from}-${b.to}`;
    const {session,metrics}=await createPiExperimentSession({runDir,role,systemPrompt:`You are a strict short-drama reviewer. The following market contract is non-negotiable:\n${marketContract}\n\nOnly report real P0/P1/P2 defects with episode numbers. Any country/culture/name/institution violation is P1. P0 means upstream/systemic, P1 needs repair, P2 is a note. Submit through the tool.`,customTools:[submit],toolNames:['submit_review']});
    let outcome='completed';try{await promptWithWatchdog(session,metrics,scripts.join('\n\n'));}catch(error){outcome='failed';writeBatchMetrics(runDir,role,metrics,outcome,{error:error.message});throw error;}finally{session.dispose();}writeBatchMetrics(runDir,role,metrics,outcome);
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
  const stale=markStale(runDir,plan.episodes);
  const grouped = new Map();
  for (const finding of plan.findings || []) {
    const episode = Number(finding.episode);
    grouped.set(episode, [...(grouped.get(episode) || []), finding.reason]);
  }
  for(const [episode,reasons] of grouped){const id=`screenplay-ep-${ep(episode)}`;const file=taskPath(runDir,id);const prior=fs.existsSync(file)?JSON.parse(readText(file)):{id};const repairInstruction=reasons.length===1?reasons[0]:reasons.map((reason,index)=>`${index+1}. ${reason}`).join('\n');writeJson(file,{...prior,state:'stale',repairInstruction});if(!stale.includes(id))stale.push(id);}
  m.state='screenplay_producing';m.note=`repair requested for ${plan.episodes.join(',')}`;saveManifest(runDir,m);return {plan,stale:stale.sort()};
}
