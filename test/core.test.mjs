import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { STORYBOARD_HEADER, checkStoryboard, createRun, loadManifest, markdownDelivery, writeText } from "../src/core.mjs";
import { markStale, repairPlan } from "../src/review.mjs";
import { applyRepair } from "../src/agents.mjs";
import { inferMarketIntent, marketChecks, validateMarketSubmission } from "../src/market.mjs";

function board(ep=1) {
  const rows=[]; let total=0;
  for(let i=1;i<=12;i++){total+=5;rows.push(`| ${i} | 功能 | 画面 ${i} | EN: line / 中：台词 | 固定/中景/平视 | 道具 | 连续 | 视觉 | SFX | 5 | ${total} |`);}
  return `# 第${ep}集\n\n| ${STORYBOARD_HEADER.join(' | ')} |\n|${STORYBOARD_HEADER.map(()=> '---').join('|')}|\n${rows.join('\n')}`;
}
test('storyboard contract accepts a complete table', () => assert.deepEqual(checkStoryboard(board()), []));
test('storyboard contract rejects a missing fixed header', () => assert.ok(checkStoryboard('| 镜头号 |\n|---|\n|1|').length));
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
