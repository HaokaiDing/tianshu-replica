import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { STORYBOARD_HEADER, checkStoryboard, createRun, loadManifest, markdownDelivery, storyboardWarnings, writeText } from "../src/core.mjs";
import { markStale, repairPlan } from "../src/review.mjs";
import { applyRepair, planningWatchdogMs, screenplayChecks } from "../src/agents.mjs";
import { inferMarketIntent, marketChecks, validateMarketSubmission } from "../src/market.mjs";
import { canonicalPersonNames } from "../src/entities.mjs";

function board(ep=1) {
  const rows=[];
  for(let i=1;i<=12;i++){const id=`ep${String(ep).padStart(2,"0")}-s${String(i).padStart(2,"0")}`;rows.push(`| ${id} | 画面 ${i} | 中：台词<br>EN: line | 固定机位 / 中景 | 人物：A<br>场景：S | 音效：环境声<br>功能：${i%3===0?"情绪停留":"对峙"} | 5 |`);}
  return `# 第${ep}集\n\n| ${STORYBOARD_HEADER.join(' | ')} |\n|${STORYBOARD_HEADER.map(()=> '---').join('|')}|\n${rows.join('\n')}`;
}
test('storyboard contract accepts a complete table', () => assert.deepEqual(checkStoryboard(board()), []));
test('storyboard contract rejects a missing fixed header', () => assert.ok(checkStoryboard('| 镜头号 |\n|---|\n|1|').length));
test('storyboard warnings flag a board with no reaction beat', () => {
  const flat=board().replaceAll("情绪停留","对峙");
  assert.ok(storyboardWarnings(flat).some((w)=>w.includes("反应")));
  assert.deepEqual(storyboardWarnings(board()), []);
});
test('repair plan blocks upstream and expands pair repairs', () => {
  assert.equal(repairPlan([{episode:3,severity:'P1',scope:'pair'}], 5).episodes.join(','), '3,4');
  assert.equal(repairPlan([{episode:3,severity:'P0',scope:'local'}], 5).action, 'blocked');
});
test('stale propagation invalidates dependent tasks', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'tianshu-test-'));
  const {dir}=createRun(root,{title:'测试',episodes:30,input:'x'});
  const stale=markStale(dir,[3]);
  assert.deepEqual(stale,['screenplay-ep-04','storyboard-ep-03','storyboard-ep-04']);
  assert.equal(loadManifest(dir).episodes,30);
});
test('applyRepair marks the repaired episode and its downstream tasks stale', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'tianshu-test-'));
  const {dir}=createRun(root,{title:'测试',episodes:30,input:'x'});
  fs.mkdirSync(path.join(dir,'reviews'),{recursive:true});
  fs.writeFileSync(path.join(dir,'reviews','repair-plan.json'),JSON.stringify({action:'repair',episodes:[3],findings:[{episode:3,reason:'repair ep03 seam'}]}));
  const result=applyRepair(dir);
  assert.ok(result.stale.includes('screenplay-ep-03'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'tasks','screenplay-ep-03.json'))).repairInstruction,'repair ep03 seam');
});
test('delivery requires every checked storyboard', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'tianshu-test-'));
  const {dir}=createRun(root,{title:'测试',episodes:30,input:'x'});
  for(let ep=1;ep<=30;ep++) writeText(path.join(dir,'storyboard',`ep-${String(ep).padStart(2,'0')}.md`),board(ep));
  assert.ok(markdownDelivery(dir).includes('第30集'));
});
test('US market contract rejects Chinese carryover and requires a US anchor', () => {
  const market=inferMarketIntent('目标受众：美区女性向竖屏短剧');
  assert.equal(market.country, 'United States');
  assert.ok(marketChecks('温家客厅，林晚穿旗袍。', market).length >= 2);
  assert.deepEqual(marketChecks('纽约一家曼哈顿拍卖行里，Maya studies the receipt.', market), []);
});
test('planner market submission must match the requested country', () => {
  const market=inferMarketIntent('目标市场：美国');
  const valid={country:'United States',setting:'New York contemporary auction world',characterNaming:'Natural contemporary American names',socialContext:'US family wealth and auction institutions',culturalAnchors:['New York','estate sale']};
  assert.deepEqual(validateMarketSubmission(market, valid), []);
  assert.ok(validateMarketSubmission(market, {...valid,country:'China'}).length);
});
test('screenplay contract rejects dialogue that cannot fit a 120-second episode', () => {
  const words=Array.from({length:261},()=> 'word').join(' ');
  const screenplay=`# 第1集｜EP01\n\n## 场景一\n\n（EN）${words}\n\n${'剧情动作。'.repeat(180)}\n\n## 【本集钩子】\n局面改变。\n\n## 【连续性检查】\n状态已记录。`;
  assert.ok(screenplayChecks(screenplay,1,{anchors:[],bannedContext:[]}).some((error)=>error.includes('英文对白过长')));
});
test('screenplay duration counts inline English markers after Chinese dialogue', () => {
  const words=Array.from({length:261},()=> 'word').join(' ');
  const screenplay=`# 第1集｜EP01\n\n## 场景一\n\n（中）台词。 (EN) ${words}\n\n${'剧情动作。'.repeat(180)}\n\n## 【本集钩子】\n局面改变。\n\n## 【连续性检查】\n状态已记录。`;
  assert.ok(screenplayChecks(screenplay,1,{anchors:[],bannedContext:[]}).some((error)=>error.includes('英文对白过长')));
});
test('screenplay contract accepts full-width punctuation in paired EN markers', () => {
  const screenplay=`# 第1集｜EP01\n\n## 场景一\n\nMAYA（中）：成交。\nMAYA（EN）：Deal.\n\n${'剧情动作。'.repeat(180)}\n\n## 【本集钩子】\n局面改变。\n\n## 【连续性检查】\n状态已记录。`;
  assert.ok(!screenplayChecks(screenplay,1,{anchors:[],bannedContext:[]}).some((error)=>error.includes('缺少英文台词')));
});
test('fixed-entity contract rejects a known first name with a drifting surname', () => {
  const drifted=board().replace('画面 1','Rowan Hale 走进房间');
  assert.ok(checkStoryboard(drifted,['Rowan Kade']).some((error)=>error.includes('Rowan Hale')));
  assert.ok(screenplayChecks(`# 第1集｜EP01\n\n## 场景一\n\nRowan Hale 出场。\nMAYA（中）：成交。\nMAYA（EN）：Deal.\n\n${'剧情动作。'.repeat(180)}\n\n## 【本集钩子】\n局面改变。\n\n## 【连续性检查】\n状态已记录。`,1,{anchors:[],bannedContext:[]},['Rowan Kade']).some((error)=>error.includes('Rowan Hale')));
  assert.ok(!screenplayChecks(`# 第1集｜EP01\n\n## 场景一\n\nRowan Kade's coat is wet.\nMAYA（中）：成交。\nMAYA（EN）：Deal.\n\n${'剧情动作。'.repeat(180)}\n\n## 【本集钩子】\n局面改变。\n\n## 【连续性检查】\n状态已记录。`,1,{anchors:[],bannedContext:[]},['Rowan Kade']).some((error)=>error.includes('姓名漂移')));
  assert.ok(!screenplayChecks(`# 第1集｜EP01\n\n## 场景一\n\nVale Family Voting Trust.\nMAYA（中）：成交。\nMAYA（EN）：Deal.\n\n${'剧情动作。'.repeat(180)}\n\n## 【本集钩子】\n局面改变。\n\n## 【连续性检查】\n状态已记录。`,1,{anchors:[],bannedContext:[]},['Vale Row']).some((error)=>error.includes('姓名漂移')));
});
test('fixed-entity contract derives people from the character bible, not team or company names', () => {
  assert.deepEqual(canonicalPersonNames('Tessa Ward (31): analyst. Fixed entities: Windsor Foundry.', ['Tessa Ward','Windsor Foundry']),['Tessa Ward']);
});
test('60-episode planning gets a longer watchdog without changing 30-episode production', () => {
  assert.equal(planningWatchdogMs(30),180_000);
  assert.equal(planningWatchdogMs(60),600_000);
});
