import fs from "node:fs";
import path from "node:path";
import { Type, createPiExperimentSession, defineTool, promptWithWatchdog, readText, sha, writeJson, writeText } from "./experiments/lib.mjs";
import { STORYBOARD_HEADER, checkStoryboard, loadManifest, saveManifest, storyboardWarnings, taskPath } from "./core.mjs";
import { screenplayBilingualErrors } from "./bilingual.mjs";
import { canonicalPersonNames, fixedEntityErrors } from "./entities.mjs";
import { continuityContext, continuityIsAccepted, extractContinuityUpdate, invalidateContinuityFrom, reviewContinuityUpdate, stageContinuityProposal } from "./continuity.mjs";
import { inferMarketIntent, marketArtifactDigest, marketChecks, marketContractMarkdown, validateMarketSubmission } from "./market.mjs";
import { loadProductionContract, productionContractDigest, productionContractMarkdown } from "./production-contract.mjs";
import { reviewStage, stageArtifactDigest } from "./semantic-review.mjs";
import { appendRunMetrics } from "./metrics.mjs";
import { replicationPlannerContext } from "./replication.mjs";
import { sampleContext } from "./sample.mjs";

const ep = (n) => String(n).padStart(2, "0");
const batches = (total) => Array.from({length:Math.ceil(total/5)},(_,i)=>({from:i*5+1,to:Math.min(total,i*5+5)}));
const appendAgentEvent=(runDir,event)=>fs.appendFileSync(path.join(runDir,"events.jsonl"),`${JSON.stringify({at:new Date().toISOString(),...event})}\n`);
export const planningWatchdogMs = (episodes) => Number(episodes) === 60 ? 600_000 : 180_000;
export const nextContinuityRepairAttempt=(task={})=>Number(task.continuityRepairAttempt||0)+1;
export function routeContinuityRejectToWriter(runDir,{episode,error,taskFile,prior={},attempt,maxAttempts=2}) {
  if(error.code!=="CONTINUITY_REJECTED")throw error;
  appendAgentEvent(runDir,{type:"continuity_rejected",actorRole:"ContinuityAgent",episode,attempt,reason:error.review?.reason||error.message});
  if(attempt>maxAttempts){const blocked=loadManifest(runDir);blocked.state="needs_human_review";blocked.note=`continuity repair budget exhausted at episode ${episode}: ${error.review?.reason||error.message}`;saveManifest(runDir,blocked);throw error;}
  const instruction=[`连续性复核拒绝了当前第 ${episode} 集。`,`证据：${error.review?.reason||error.message}`,`验收：重写本集，使本集真实事件能够从上一集已接受快照自然发生，并提交准确的 continuityUpdate。`,`必须保留：已批准大纲、人物身份、市场合同和本集仍有效的剧情功能。`,`不得改动：既有连续性合同和此前已接受的事实。`].join("\n");
  writeJson(taskFile,{...prior,state:"stale",repairInstruction:instruction,continuityRepairAttempt:attempt});return {routed:true,attempt};
}
function outlineWindow(outline, episode, total) {
  const parts = outline.split(/(?=^## 第\d+集)/m);
  const wanted = new Set([episode - 1, episode, episode + 1].filter((n) => n >= 1 && n <= total));
  return parts.filter((part) => wanted.has(Number(part.match(/^## 第(\d+)集/m)?.[1]))).join("\n\n");
}
function artifactTools(runDir, workDir) {
  const roots=['canonical','screenplay','storyboard','continuity','reviews','research'];
  const read=defineTool({name:'read_artifact',label:'Read artifact',description:'Read an approved, non-stale project artifact by relative path.',parameters:Type.Object({ref:Type.String()}),async execute(_id,p){const f=path.resolve(runDir,p.ref);if(!roots.some(r=>f.startsWith(path.join(runDir,r)+path.sep))||!fs.existsSync(f))return {content:[{type:'text',text:'REJECTED artifact unavailable'}],details:{},terminate:false};const match=p.ref.match(/^(screenplay|storyboard)\/ep-(\d+)\.md$/);if(match){const task=taskPath(runDir,`${match[1]}-ep-${match[2]}`);if(!fs.existsSync(task))return {content:[{type:'text',text:'REJECTED artifact has no approved task'}],details:{},terminate:false};const record=JSON.parse(readText(task)),content=readText(f);if(record.state!=="passed"||record.digest!==sha(content))return {content:[{type:'text',text:'REJECTED artifact is stale'}],details:{},terminate:false};}return {content:[{type:'text',text:readText(f).slice(0,12000)}],details:{ref:p.ref,digest:sha(readText(f))}};}});
  const write=defineTool({name:'write_draft',label:'Write draft',description:'Write the complete current-episode draft only inside this task workspace. This is not the final submission.',parameters:Type.Object({markdown:Type.String({minLength:700})}),async execute(_id,p){writeText(path.join(workDir,'draft.md'),p.markdown);return {content:[{type:'text',text:'draft saved; run checks next'}],details:{}};}});
  return [read,write];
}
const writeBatchMetrics = appendRunMetrics;
export function shortcutChecks(markdown) {
  const failures=[];
  if (/(?:监控(?:摄像头|录像)?|录像|CCTV|security camera|surveillance)/i.test(markdown)) failures.push('禁止把监控或录像作为剧情证据');
  if (/(?:DNA|基因鉴定)/i.test(markdown)) failures.push('禁止使用 DNA 作为翻盘手段');
  return failures;
}
function plotChecks(markdown, productionRoute) {
  return productionRoute === "tianshu-replication" ? [] : shortcutChecks(markdown);
}
export function storyboardChecks(markdown, market, canonicalNames, productionContract, productionRoute = null) {
  return [...checkStoryboard(markdown, canonicalNames, productionContract), ...marketChecks(markdown, market), ...plotChecks(markdown, productionRoute)];
}
export function screenplayChecks(markdown, episode, market, canonicalNames = [], productionContract = null, productionRoute = null) {
  const failures=[];
  const contract = productionContract || { screenplay: { englishDialogueWordLimit: 260, maxScenes: 4 } };
  if (markdown.length < 700) failures.push('剧本过短');
  const lines = markdown.split('\n');
  const englishSegments=[];
  for(let index=0;index<lines.length;index++){
    const marker=lines[index].match(/(?:（EN）|\(EN\)|EN\s*[:：])/);
    if(!marker)continue;
    let value=lines[index].slice((marker.index||0)+marker[0].length).trim();
    if(!value&&index+1<lines.length)value=lines[index+1].trim();
    englishSegments.push(value);
  }
  const englishDialogue = englishSegments.join(' ').trim();
  const englishDialogueWords = englishDialogue ? englishDialogue.split(/\s+/).filter(Boolean).length : 0;
  if (englishDialogueWords > contract.screenplay.englishDialogueWordLimit) failures.push(`英文对白过长 ${englishDialogueWords} 词（上限 ${contract.screenplay.englishDialogueWordLimit}）`);
  const sceneCount = (markdown.match(/^##\s*(?:场景|SCENE\b)/gim) || []).length;
  if (sceneCount > contract.screenplay.maxScenes) failures.push(`场景过多 ${sceneCount}（上限 ${contract.screenplay.maxScenes}）`);
  if (!/【本集钩子】/.test(markdown)) failures.push('缺少【本集钩子】');
  if (!/【连续性检查】/.test(markdown)) failures.push('缺少【连续性检查】');
  if (!/(?:（EN）|\(EN\)|(?:EN|英)\s*[:：])|^[A-Za-z][A-Za-z .'-]{1,40}[:：]|\/\s*[A-Za-z][A-Za-z .,'"'!?—-]{4,}/m.test(markdown)) failures.push('缺少英文台词');
  if (!new RegExp(`(?:第?${episode}集|EP(?:ISODE)?\\s*${episode})`, 'i').test(markdown)) failures.push('缺少本集标识');
  // A source story may legitimately contain a recording or DNA event. In replica
  // mode, source fidelity and plot quality belong to the independent Reviewer.
  const plotErrors = plotChecks(markdown, productionRoute);
  return [...failures, ...screenplayBilingualErrors(markdown), ...fixedEntityErrors(markdown, canonicalNames), ...marketChecks(markdown, market), ...plotErrors];
}
export function planningSystemPrompt(manifest) {
  const replica = manifest.productionRoute === "tianshu-replication";
  const goal = replica
    ? `Adapt the supplied source outline into a ${manifest.episodes}-episode planning bundle. Preserve its event order, conflicts, reversals, character states, and episode hooks; do not invent a new story. Keep planning compact and leave dialogue, action choreography, and scene detail to Writer. Preserve the source protagonist and story mechanisms, including evidence devices when already part of the source; do not impose a different protagonist or genre.`
    : `Create a strong ${manifest.episodes}-episode vertical-drama plan from the brief. Use one emotion engine, concrete hooks, active heroine, no police/court/DNA/surveillance shortcuts.`;
  return `You are Tianshu Planner. ${goal} The target market and production contract are hard creative constraints.${replica ? " If a source event conflicts with those constraints, identify it for independent review rather than silently replacing the source event." : ""} The first promotional episodes need immediate, visually legible conflict and extractable payoff beats. Also write a natural-language continuity baseline: immutable identities and world rules, opening custody/debt/knowledge states, and any hard future rails. Do not pretend later episode changes have already happened; those are maintained by the Continuity Agent. Submit only through the tool.${sampleContext(manifest) ? `\n\n${sampleContext(manifest)}` : ""}`;
}
export function planningTaskPrompt(runDir, productionContract, intent, repair = null) {
  const input = readText(path.join(runDir, "canonical", "input.md"));
  const sourceContext = replicationPlannerContext(runDir);
  const repairContext = repair ? `\n\nThis is a bounded planning repair. Preserve every approved strength and change only what the findings require.\nCurrent planning bundle:\n${["acts.md","design.md","outline.md","characters.md","ledger.json","continuity-contract.md"].map((name)=>{const file=path.join(runDir,"canonical",name);return fs.existsSync(file)?`## ${name}\n${readText(file)}`:"";}).join("\n\n")}\n\nRepair plan:\n${JSON.stringify(repair.findings)}` : "";
  const scopeContext = sampleContext(loadManifest(runDir));
  return `Brief:\n${input}\n\nNon-negotiable market intent:\n${marketContractMarkdown(intent)}\n\nProduction contract:\n${productionContractMarkdown(productionContract)}${repairContext}${sourceContext ? `\n\n${sourceContext}` : ""}${scopeContext ? `\n\n${scopeContext}` : ""}`;
}

async function generatePlanningBundle(runDir, repair = null) {
  const m=loadManifest(runDir), input=readText(path.join(runDir,"canonical","input.md")), intent=inferMarketIntent(input); let accepted=false;
  const productionContract = loadProductionContract(runDir);
  const taskPrompt = planningTaskPrompt(runDir, productionContract, intent, repair);
  const submit=defineTool({
    name:"submit_planning_bundle",
    label:"Submit planning",
    description:"Submit a complete planning bundle, natural-language continuity baseline, target-market contract, and exact episode outline.",
    parameters:Type.Object({
      market:Type.Object({country:Type.String(),setting:Type.String({minLength:20}),characterNaming:Type.String({minLength:20}),socialContext:Type.String({minLength:20}),culturalAnchors:Type.Array(Type.String({minLength:2}),{minItems:2})}),
      acts:Type.String({minLength:100}),
      design:Type.String({minLength:100}),
      characters:Type.String({minLength:100}),
      ledger:Type.Object({names:Type.Array(Type.String(),{minItems:2}),facts:Type.Array(Type.String(),{minItems:3})}),
      continuityContract:Type.String({minLength:200}),
      outline:Type.Array(Type.String({minLength:40}),{minItems:m.episodes,maxItems:m.episodes}),
    }),
    async execute(_id,p){
      const errors=validateMarketSubmission(intent,p.market);
      if(errors.length)return {content:[{type:'text',text:`REJECTED ${errors.join('；')}`}],details:{errors},terminate:false};
      const contract={...intent,...p.market};
      writeJson(path.join(runDir,"canonical","market.json"),contract);
      writeText(path.join(runDir,"canonical","market-contract.md"),marketContractMarkdown(contract));
      writeText(path.join(runDir,"canonical","acts.md"),p.acts);
      writeText(path.join(runDir,"canonical","design.md"),p.design);
      writeText(path.join(runDir,"canonical","characters.md"),p.characters);
      writeJson(path.join(runDir,"canonical","ledger.json"),p.ledger);
      writeText(path.join(runDir,"canonical","continuity-contract.md"),p.continuityContract);
      writeText(path.join(runDir,"canonical","outline.md"),p.outline.map((x,i)=>`## 第${i+1}集\n${x}`).join("\n\n"));
      accepted=true;
      return {content:[{type:"text",text:"ACCEPTED planning, continuity, and market contracts"}],details:{},terminate:true};
    }
  });
  const role = `planner-cycle-${Number(m.reviewCycles?.planning || 0) + 1}`;
  const {session,metrics}=await createPiExperimentSession({runDir,role,systemPrompt:planningSystemPrompt(m),customTools:[submit],toolNames:["submit_planning_bundle"]});
  let outcome = "completed";
  try {
    await promptWithWatchdog(session, metrics, taskPrompt, planningWatchdogMs(m.episodes));
    if (!accepted) throw new Error("planner did not submit");
    return metrics;
  } catch (error) {
    outcome = "failed";
    throw error;
  } finally {
    session.dispose();
    appendRunMetrics(runDir, role, metrics, outcome);
  }
}

export function completedPlanningMetrics(runDir) {
  const manifest = loadManifest(runDir);
  if (manifest.state !== "planning") return null;
  const cycle = Number(manifest.reviewCycles?.planning || 0) + 1;
  const file = path.join(runDir, "metrics", `planner-cycle-${cycle}.json`);
  if (!fs.existsSync(file)) return null;
  const metrics = JSON.parse(readText(file));
  const artifacts = ["acts.md", "design.md", "outline.md", "characters.md", "ledger.json", "continuity-contract.md", "market.json", "market-contract.md"];
  return metrics.outcome === "completed" && artifacts.every((name) => fs.existsSync(path.join(runDir, "canonical", name))) ? metrics : null;
}

export async function plan(runDir) {
  const manifest = loadManifest(runDir);
  if (!["draft", "planning", "returned"].includes(manifest.state)) throw new Error(`plan requires draft, planning, or returned; got ${manifest.state}`);
  let pendingMetrics = completedPlanningMetrics(runDir);
  manifest.state = "planning";
  saveManifest(runDir, manifest);
  let repair = null;
  while (true) {
    const metrics = pendingMetrics || await generatePlanningBundle(runDir, repair);
    pendingMetrics = null;
    const report = await reviewStage(runDir, "planning");
    const current = loadManifest(runDir);
    current.planMetrics = metrics;
    if (report.plan.action === "pass") {
      current.state = "awaiting_approval";
      current.note = "planning passed independent review";
      saveManifest(runDir, current);
      return report;
    }
    if (report.plan.action === "blocked") {
      current.state = "needs_human_review";
      current.note = report.plan.reasons.map((item) => item.reason).join("; ");
      saveManifest(runDir, current);
      return report;
    }
    repair = report.plan;
    current.revision += 1;
    current.state = "planning";
    saveManifest(runDir, current);
  }
}
export async function produceScripts(runDir) {
  const m=loadManifest(runDir);
  if(!["approved","screenplay_producing","screenplay_repairing"].includes(m.state))throw new Error(`produce requires approved or screenplay repair state, got ${m.state}`);
  const outline=readText(path.join(runDir,"canonical","outline.md"));
  const chars=readText(path.join(runDir,"canonical","characters.md"));
  const ledger=readText(path.join(runDir,"canonical","ledger.json"));
  const ledgerNames=canonicalPersonNames(chars,JSON.parse(ledger).names||[]);
  const market=JSON.parse(readText(path.join(runDir,"canonical","market.json")));
  const marketContract=readText(path.join(runDir,"canonical","market-contract.md"));
  const productionContract=loadProductionContract(runDir), contractDigest=productionContractDigest(productionContract), contractText=productionContractMarkdown(productionContract);
  m.state="screenplay_producing";saveManifest(runDir,m);
  for(const b of batches(m.episodes)){
    let active={episode:b.from};
    const workDir=path.join(runDir,'work',`writer-${b.from}-${b.to}`);
    const routeContinuityReject=(episode,error,taskFile,prior={})=>{const durable=fs.existsSync(taskFile)?JSON.parse(readText(taskFile)):prior,attempt=nextContinuityRepairAttempt(durable);return routeContinuityRejectToWriter(runDir,{episode,error,taskFile,prior:durable,attempt,maxAttempts:productionContract.revision.maxContinuityRepairAttempts}).routed;};
    let lastChecks=[];
    const runChecks=defineTool({name:'run_checks',label:'Check screenplay',description:'Validate the draft for the current episode before submission, including the target-market and production contracts.',parameters:Type.Object({}),async execute(){const draft=path.join(workDir,'draft.md');if(!fs.existsSync(draft))lastChecks=['尚未写入草稿'];else lastChecks=screenplayChecks(readText(draft),active.episode,market,ledgerNames,productionContract,m.productionRoute);return {content:[{type:'text',text:lastChecks.length?`FAIL: ${lastChecks.join('；')}`:'PASS: draft is eligible for submission'}],details:{failures:lastChecks},terminate:false};}});
    const submit=defineTool({
      name:"submit_screenplay",
      label:"Submit screenplay",
      description:"Submit the checked draft plus a natural-language continuity update. The tool reads the saved draft; never paste a screenplay into this call.",
      parameters:Type.Object({episode:Type.Integer(),continuityUpdate:Type.String({minLength:8})}),
      async execute(_id,p){
        if(p.episode!==active.episode)return {content:[{type:"text",text:"REJECTED wrong episode"}],details:{},terminate:false};
        const draft=path.join(workDir,'draft.md');
        if(!fs.existsSync(draft))return {content:[{type:'text',text:'REJECTED no draft'}],details:{},terminate:false};
        const markdown=readText(draft), errors=screenplayChecks(markdown,p.episode,market,ledgerNames,productionContract,m.productionRoute);
        if(errors.length)return {content:[{type:'text',text:`REJECTED ${errors.join('；')}`}],details:{errors},terminate:false};
        writeText(path.join(runDir,"screenplay",`ep-${ep(p.episode)}.md`),markdown);
        stageContinuityProposal(runDir,{episode:p.episode,screenplay:markdown,proposedUpdate:p.continuityUpdate});
        const continuity=continuityContext(runDir);
        const taskFile=taskPath(runDir,`screenplay-ep-${ep(p.episode)}`),priorTask=fs.existsSync(taskFile)?JSON.parse(readText(taskFile)):{};
        writeJson(taskFile,{...priorTask,state:"passed",digest:sha(markdown),contractDigest,marketDigest:marketArtifactDigest(runDir),previousContinuityDigest:continuity.current.snapshotDigest,actorRole:"TianshuWriter"});
        return {content:[{type:"text",text:"ACCEPTED screenplay; continuity proposal staged for independent review"}],details:{},terminate:true};
      }
    });
    const tools=artifactTools(runDir,workDir), role=`writer-${b.from}-${b.to}`;
    const {session,metrics}=await createPiExperimentSession({runDir,role,systemPrompt:`你是天书剧本作者，一次只做指定的一集。产物是按场景组织的剧本、动作与双语对白，不预先生成逐镜分镜表或逐镜时间码；具体拆镜与单镜时长交下游分镜阶段。每次任务必须严格走三步：1) 用 write_draft 写完整剧本；2) 调用 run_checks；3) 仅在收到 PASS 后调用 submit_screenplay，提交当前集数和本集自然语言 continuityUpdate。continuityUpdate 只写本集真正发生的状态变化。你不能直接修改连续性合同，独立 Continuity Agent 会复核。submit 会读取草稿，绝不把剧本粘进参数。不要输出解释、不要停在半成品。每句对白必须连续写成角色（中）和角色（EN）两行。剧本必须有【本集钩子】和【连续性检查】。冲突必须产生后果。市场合同、生产合同与连续性合同都是硬约束。\n\n${contractText}`,customTools:[...tools,runChecks,submit],toolNames:["read_artifact","write_draft","run_checks","submit_screenplay"]});
    let outcome='completed';
    try{
      for(let n=b.from;n<=b.to;n++){
        const task=taskPath(runDir,`screenplay-ep-${ep(n)}`);
        const artifact=path.join(runDir,"screenplay",`ep-${ep(n)}.md`);
        const prior=fs.existsSync(task)?JSON.parse(readText(task)):null;
        if(prior?.state==='passed'&&fs.existsSync(artifact)&&prior.digest===sha(readText(artifact))&&prior.contractDigest===contractDigest&&prior.marketDigest===marketArtifactDigest(runDir)){
          const screenplay=readText(artifact);
          if(continuityIsAccepted(runDir,n,sha(screenplay)))continue;
          const recordPath=path.join(runDir,"continuity",`ep-${ep(n)}.json`);
          const proposed=fs.existsSync(recordPath)?JSON.parse(readText(recordPath)).proposedUpdate:extractContinuityUpdate(screenplay);
          if(!proposed)throw new Error(`episode ${n} is missing a continuity proposal`);
          const previousContinuityDigest=continuityContext(runDir).current.snapshotDigest;
          try{await reviewContinuityUpdate(runDir,{episode:n,screenplay,proposedUpdate:proposed});}catch(error){if(routeContinuityReject(n,error,task,prior)){n-=1;continue;}}
          writeJson(task,{...prior,previousContinuityDigest,continuityDigest:JSON.parse(readText(recordPath)).snapshotDigest});
          continue;
        }
        active.episode=n;lastChecks=[];
        const continuity=continuityContext(runDir);
        const nearby=[n-1,n+1].filter(x=>x>=1&&x<=m.episodes).map(x=>{const f=path.join(runDir,'screenplay',`ep-${ep(x)}.md`);return fs.existsSync(f)?`第${x}集：\n${readText(f).slice(0,14000)}`:'';}).filter(Boolean).join('\n\n');
        const repair=prior?.repairInstruction?`\n这是修订任务。保留下面现有剧本的有效内容，只修复列出的缺陷。\n现有剧本：\n${fs.existsSync(artifact)?readText(artifact).slice(0,30000):''}\n修订要求：\n${prior.repairInstruction}`:"";
        const taskPrompt=`${sampleContext(m)}\n只写第 ${n} 集，并按 write_draft → run_checks → submit_screenplay 的顺序调用工具。\n市场与文化合同：\n${marketContract}\n\n生产合同：\n${contractText}\n\n静态连续性合同：\n${continuity.contract.slice(0,18000)}\n\n截至上一集的动态连续性快照：\n${continuity.current.snapshot.slice(0,12000)}\n\n本集及相邻集大纲：\n${outlineWindow(outline,n,m.episodes)}\n人物：${chars.slice(0,12000)}\n初始台账：${ledger.slice(0,8000)}\n相邻集上下文：\n${nearby}${repair}`;
        await promptWithWatchdog(session,metrics,taskPrompt,1800000);
        if(!fs.existsSync(artifact))await promptWithWatchdog(session,metrics,`上一回合没有生成第 ${n} 集正式文件。现在只做三步：write_draft；run_checks；submit_screenplay，同时提交 continuityUpdate。不要解释，不要开始别集。`,120000);
        if(!fs.existsSync(artifact))throw new Error(`writer did not submit episode ${n}`);
        const screenplay=readText(artifact);
        const recordPath=path.join(runDir,"continuity",`ep-${ep(n)}.json`);
        const proposed=fs.existsSync(recordPath)?JSON.parse(readText(recordPath)).proposedUpdate:extractContinuityUpdate(screenplay);
        if(!proposed)throw new Error(`writer did not submit continuity for episode ${n}`);
        try{await reviewContinuityUpdate(runDir,{episode:n,screenplay,proposedUpdate:proposed});}catch(error){if(routeContinuityReject(n,error,task,JSON.parse(readText(task)))){n-=1;continue;}}
        const acceptedContinuity=JSON.parse(readText(recordPath)),taskRecord=JSON.parse(readText(task));
        writeJson(task,{...taskRecord,continuityDigest:acceptedContinuity.snapshotDigest});
      }
    }catch(error){outcome='failed';writeBatchMetrics(runDir,role,metrics,outcome,{error:error.message});throw error;}finally{session.dispose();}
    writeBatchMetrics(runDir,role,metrics,outcome);
  }
  m.state="screenplay_reviewing";saveManifest(runDir,m);
}
export async function produceStoryboards(runDir) {
  const m=loadManifest(runDir);if(!["screenplay_passed","storyboard_producing","storyboard_repairing"].includes(m.state))throw new Error(`storyboard requires screenplay_passed or storyboard repair state, got ${m.state}`);const market=JSON.parse(readText(path.join(runDir,"canonical","market.json"))),marketContract=readText(path.join(runDir,"canonical","market-contract.md")),characters=readText(path.join(runDir,"canonical","characters.md")),ledgerNames=canonicalPersonNames(characters,JSON.parse(readText(path.join(runDir,"canonical","ledger.json"))).names||[]),productionContract=loadProductionContract(runDir),contractDigest=productionContractDigest(productionContract),contractText=productionContractMarkdown(productionContract);m.state="storyboard_producing";saveManifest(runDir,m);
  for(const b of batches(m.episodes)){let active={episode:b.from};const workDir=path.join(runDir,'work',`storyboard-${b.from}-${b.to}`);const runChecks=defineTool({name:'run_checks',label:'Check storyboard',description:'Validate the saved draft for the current episode before submission, including the target-market and production contracts.',parameters:Type.Object({}),async execute(){const draft=path.join(workDir,'draft.md'),errors=fs.existsSync(draft)?storyboardChecks(readText(draft),market,ledgerNames,productionContract,m.productionRoute):['尚未写入草稿'];const warnings=fs.existsSync(draft)?storyboardWarnings(readText(draft)):[];const warn=warnings.length?`\nWARN(不阻断，但提交前应尽量修正): ${warnings.join('；')}`:'';return {content:[{type:'text',text:(errors.length?`FAIL: ${errors.join('；')}`:'PASS: storyboard is eligible for submission')+warn}],details:{errors,warnings},terminate:false};}});const submit=defineTool({name:"submit_storyboard",label:"Submit storyboard",description:"Submit the checked saved draft. The tool reads the saved draft; never paste a storyboard into this call.",parameters:Type.Object({episode:Type.Integer()}),async execute(_id,p){const draft=path.join(workDir,'draft.md');const errors=p.episode===active.episode&&fs.existsSync(draft)?storyboardChecks(readText(draft),market,ledgerNames,productionContract,m.productionRoute):['wrong episode or missing draft'];if(errors.length)return {content:[{type:"text",text:`REJECTED ${errors.join("; ")}`}],details:{errors},terminate:false};const markdown=readText(draft),source=readText(path.join(runDir,"screenplay",`ep-${ep(p.episode)}.md`));writeText(path.join(runDir,"storyboard",`ep-${ep(p.episode)}.md`),markdown);writeJson(taskPath(runDir,`storyboard-ep-${ep(p.episode)}`),{state:"passed",digest:sha(markdown),sourceScreenplayDigest:sha(source),contractDigest,marketDigest:marketArtifactDigest(runDir),actorRole:"TianshuStoryboardAgent"});return {content:[{type:"text",text:"ACCEPTED storyboard"}],details:{},terminate:true};}});
    const tools=artifactTools(runDir,workDir), role=`storyboard-${b.from}-${b.to}`;
    const {session,metrics}=await createPiExperimentSession({runDir,role,systemPrompt:`你是天书分镜导演。每次任务必须严格走三步：1) 用 write_draft 写完整分镜；2) 调用 run_checks；3) 只有 PASS 后调用 submit_storyboard 并传当前集数。submit 会读取草稿，绝不把分镜粘进 submit 参数。不要输出解释。表头必须是：| ${STORYBOARD_HEADER.join(" | ")} |。镜头号格式为 epNN-sNN（两位集号+两位镜号）。单元格内换行用 <br>：台词格写"角色：中文台词<br>EN: English line<br>表演：……"（无台词写"无台词"）；运镜格写"运镜 / 景别<br>走位：……"；人物图/场景图格写"人物：……<br>场景：……<br>道具：……"；备注格写"音效：……<br>功能：一个叙事功能标签（如 建立/反应/情绪停留/对峙/揭示/钩子定格）<br>连续性：与上一镜的衔接关系<br>制作：……"。\n\n${contractText}
节奏与衔接原则：
- 以剧本正文的实际动作、对白和时间线为准；头部钩子说明和尾部自检若与正文不符，不能覆盖正文，也不能据其添加新事件。
- 母本若带拍点或参考时间码，保留其剧情和节奏功能，再按生产合同合并或拆分为合规镜头；参考拍点不等于必须原样照搬的最终镜头。
- 一镜一事：每个镜头只承载一个新信息点（新道具、新事实或新伏笔）。
- 动作有反应：重要台词或动作之后给情绪停留镜，高潮前留呼吸，不每镜都推进新情节。
- 台词有落点：定调台词或新场景建立镜之后，先给反应/停留镜再进入新节拍，不说完就走。
- 钩子独立：本集钩子镜独立成镜并给足特写时长，不与其他信息合并。
- 衔接显式化：同时空连续镜在备注格"连续性"行写明继承的视线、站位、道具；时空跳转先给建立镜再切近景。市场合同是硬约束：镜头中的人物、场景、道具、建筑、机构、服装和视觉提示必须属于目标国家，而非默认中国语境。`,customTools:[...tools,runChecks,submit],toolNames:["read_artifact","write_draft","run_checks","submit_storyboard"]});
    let outcome='completed';try{for(let n=b.from;n<=b.to;n++){const task=taskPath(runDir,`storyboard-ep-${ep(n)}`);const artifact=path.join(runDir,"storyboard",`ep-${ep(n)}.md`);const source=readText(path.join(runDir,"screenplay",`ep-${ep(n)}.md`));const prior=fs.existsSync(task)?JSON.parse(readText(task)):null;if(prior?.state==='passed'&&fs.existsSync(artifact)&&prior.digest===sha(readText(artifact))&&prior.contractDigest===contractDigest&&prior.sourceScreenplayDigest===sha(source))continue;active.episode=n;const repair=prior?.repairInstruction?`\n\n这是受约束的分镜修订任务。保留有效内容，只修下面的问题。\n现有分镜：\n${fs.existsSync(artifact)?readText(artifact):""}\n修订要求：\n${prior.repairInstruction}`:"";await promptWithWatchdog(session,metrics,`${sampleContext(m)}\n只制作第 ${n} 集，按 write_draft → run_checks → submit_storyboard 的顺序调用工具。\n市场与文化合同：\n${marketContract}\n\n生产合同：\n${contractText}\n\n剧本：\n${source}${repair}`,1800000);if(!fs.existsSync(artifact))throw new Error(`storyboard agent did not submit episode ${n}`);}}catch(error){outcome='failed';writeBatchMetrics(runDir,role,metrics,outcome,{error:error.message});throw error;}finally{session.dispose();}writeBatchMetrics(runDir,role,metrics,outcome);}
  m.state="storyboard_reviewing";saveManifest(runDir,m);
}

export async function reviewScripts(runDir, { operatorNote = "" } = {}) {
  const m=loadManifest(runDir);
  if(m.state!=="screenplay_reviewing") {
    const latest=path.join(runDir,"reviews","screenplay-latest.json");
    if(m.state!=="needs_human_review"||!operatorNote.trim()||!fs.existsSync(latest)||JSON.parse(readText(latest)).plan?.action!=="blocked")throw new Error(`screenplay review requires screenplay_reviewing, or an explicit review note for a blocked screenplay review; got ${m.state}`);
  }
  const report=await reviewStage(runDir,"screenplay",{operatorNote}),current=loadManifest(runDir);
  if(report.plan.action==="pass"){current.state="screenplay_passed";current.note="screenplay passed independent series review";}
  else if(report.plan.action==="repair"){current.state="screenplay_repairing";current.note=`screenplay repair cycle ${report.cycle}`;}
  saveManifest(runDir,current);return report;
}

export async function reviewStoryboards(runDir, { operatorNote = "" } = {}) {
  const m=loadManifest(runDir);
  if(m.state!=="storyboard_reviewing") {
    const latest=path.join(runDir,"reviews","storyboard-latest.json");
    const expectedAction=m.state==="storyboard_repairing"?"repair":m.state==="needs_human_review"?"blocked":null;
    if(!expectedAction||!operatorNote.trim()||!fs.existsSync(latest)||JSON.parse(readText(latest)).plan?.action!==expectedAction)throw new Error(`storyboard review requires storyboard_reviewing, or an explicit review note for a pending repair or blocked storyboard review; got ${m.state}`);
  }
  const report=await reviewStage(runDir,"storyboard",{operatorNote}),current=loadManifest(runDir);
  if(report.plan.action==="pass"){current.state="final_review";current.note="storyboard passed independent series review";}
  else if(report.plan.action==="repair"){current.state="storyboard_repairing";current.note=`storyboard repair cycle ${report.cycle}`;}
  saveManifest(runDir,current);return report;
}

function latestRepairReport(runDir) {
  for(const stage of ["storyboard","screenplay","planning"]){const file=path.join(runDir,"reviews",`${stage}-latest.json`);if(fs.existsSync(file)){const report=JSON.parse(readText(file));if(report.plan?.action==="repair")return report;}}
  throw new Error("no active repair plan");
}

function repairInstruction(findings) {
  return findings.map((finding,index)=>[
    `${index+1}. [${finding.id}] ${finding.repairInstruction}`,
    `   证据：${finding.evidence}`,
    `   验收：${finding.acceptance}`,
    finding.preserve?.length?`   必须保留：${finding.preserve.join("；")}`:"",
    finding.doNotChange?.length?`   不得改动：${finding.doNotChange.join("；")}`:"",
  ].filter(Boolean).join("\n")).join("\n");
}

function removeReviewProof(runDir,stages){for(const stage of stages){const file=path.join(runDir,"reviews",`${stage}-final.json`);if(fs.existsSync(file))fs.unlinkSync(file);}}

export function applyRepair(runDir,suppliedReport=null) {
  const m=loadManifest(runDir),report=suppliedReport||latestRepairReport(runDir),plan=report.plan;
  if(plan.action!=="repair")throw new Error(`repair plan action is ${plan.action}`);
  if(stageArtifactDigest(runDir,plan.stage)!==plan.artifactDigest)throw new Error("repair plan artifact digest is stale");
  const contractDigest=productionContractDigest(loadProductionContract(runDir));if(plan.contractDigest!==contractDigest)throw new Error("repair plan production contract is stale");
  if(report.marketDigest!==marketArtifactDigest(runDir))throw new Error("repair plan market contract is stale");
  const repairable=plan.findings.filter((finding)=>finding.severity==="P1"||(finding.severity==="P2"&&finding.disposition==="repair")),grouped=new Map();
  for(const finding of repairable){const targets=finding.scope==="pair"&&finding.episode<m.episodes?[finding.episode,finding.episode+1]:[finding.episode];for(const episode of targets)grouped.set(episode,[...(grouped.get(episode)||[]),finding]);}
  const stale=[];
  if(plan.stage==="screenplay"){
    const earliest=Math.min(...grouped.keys()),continuity=invalidateContinuityFrom(runDir,earliest,m.episodes,`screenplay repair cycle ${plan.cycle}`);
    appendAgentEvent(runDir,{type:"continuity_rewound",actorRole:"Runtime",fromEpisode:earliest,restoredThrough:continuity.restoredThrough,cycle:plan.cycle});
    for(const [episode,findings] of grouped){const id=`screenplay-ep-${ep(episode)}`,file=taskPath(runDir,id),prior=fs.existsSync(file)?JSON.parse(readText(file)):{id};writeJson(file,{...prior,state:"stale",repairInstruction:repairInstruction(findings),repairCycle:plan.cycle});stale.push(id);}
    for(let episode=earliest;episode<=m.episodes;episode++){const id=`storyboard-ep-${ep(episode)}`,file=taskPath(runDir,id),prior=fs.existsSync(file)?JSON.parse(readText(file)):{id};writeJson(file,{...prior,state:"stale",staleReason:`screenplay changed from episode ${earliest}`});stale.push(id);}
    removeReviewProof(runDir,["screenplay","storyboard"]);m.state="screenplay_producing";m.note=`Tianshu Writer repair cycle ${plan.cycle}`;saveManifest(runDir,m);return {plan,stale:[...new Set(stale)].sort(),continuity};
  }
  if(plan.stage==="storyboard"){
    for(const [episode,findings] of grouped){const id=`storyboard-ep-${ep(episode)}`,file=taskPath(runDir,id),prior=fs.existsSync(file)?JSON.parse(readText(file)):{id};writeJson(file,{...prior,state:"stale",repairInstruction:repairInstruction(findings),repairCycle:plan.cycle});stale.push(id);}
    removeReviewProof(runDir,["storyboard"]);m.state="storyboard_producing";m.note=`Tianshu Storyboard Agent repair cycle ${plan.cycle}`;saveManifest(runDir,m);return {plan,stale:stale.sort()};
  }
  throw new Error(`applyRepair does not directly edit ${plan.stage} artifacts`);
}
