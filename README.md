# TianshuAgent

TianshuAgent 把短剧 brief 推进成固定 7 列的 ReelClaw 分镜剧本。Planner、Writer、Storyboard Agent 和独立 Reviewer 都在项目内部运行；外部 Coding Agent 只负责准备 brief、启动任务、监控状态和验收交付，不直接修改正式剧本或分镜。

新项目默认使用女频竖屏短剧合同：30 集、每集 90–100 秒、12–24 镜，EP1–3 必须有前三秒冷开和可剪宣发桥段。合同保存在 `canonical/production-contract.json`，可以在初始化时传入自定义 JSON。

## 默认工作流

```text
brief
→ Planner 写规划
→ 独立规划 Reviewer 审稿
→ Planner 按 Repair Plan 修订，最多 3 轮
→ 用户批准最终大纲
→ Writer 写剧本
→ 窗口 Reviewer + 全剧 Reviewer
→ Writer 修订并复审，最多 3 轮
→ Storyboard Agent 拆分镜
→ 窗口 Reviewer + 全剧 Reviewer
→ Storyboard Agent 修订并复审，最多 3 轮
→ delivery gate
→ Markdown + DOCX
```

“通过”要求当前合同下的硬检查全部成功、独立终审没有 P0/P1，所有 P2 都已修复或标记为 `accepted_non_blocking`。遇到 P0、需要改已批准大纲的上游问题、同类问题影响至少 3 集、相同 finding 修后仍存在或修订轮次用尽时，任务进入 `needs_human_review`。Reviewer 没有正式提交或暂时不可用时，流程停在当前 reviewing 状态并保留恢复点，不会假装通过。

## 使用

```bash
# 创建项目并让 Planner 与规划 Reviewer 自动迭代
npm run tianshu -- init briefs/show.md --title "剧名"
npm run tianshu -- plan <run-id>

# 用户只在最终大纲处批准一次
npm run tianshu -- approve <run-id>

# 自动写剧本、审稿、修订、拆分镜、复审和交付
npm run tianshu -- run <run-id>

# 中断后继续；只跳过摘要、合同和依赖均匹配的任务
npm run tianshu -- resume <run-id>

# 查看当前状态和阻断原因
npm run tianshu -- status <run-id>
```

自定义合同：

```bash
npm run tianshu -- init briefs/show.md \
  --title "剧名" \
  --contract contracts/custom-production-contract.json
```

`run` 会取得 run 级 `.lock`，同一个项目不能被两个 Orchestrator 同时生产。新合同默认在全部质量门通过后自动生成 Markdown 和 DOCX；自定义合同可以把 `delivery.autoDeliver` 设为 `false`，让流程停在 `awaiting_delivery_approval`。

## 产物和审计

项目事实都在 `runs/<run-id>/`：

- `canonical/`：brief、生产合同、市场合同、大纲、人物和台账
- `screenplay/`：通过提交工具提升的单集剧本
- `continuity/`：逐集连续性快照、历史事件和失效存档
- `storyboard/`：通过提交工具提升的固定 7 列分镜
- `reviews/`：每轮窗口审稿、全剧审稿、Repair Plan 和最终 PASS 证明
- `tasks/`：任务状态、产物摘要、输入合同摘要和修订指令
- `events.jsonl`：Runtime 状态变化
- `deliverables/`：最终 Markdown 和 DOCX

早期剧本修订会把连续性回退到上一集，顺序复核后续状态，并使受影响的分镜和审稿证明失效。交付前会重新检查 task 状态、文件摘要、生产合同、市场合同、源剧本摘要、连续性和最终审稿证明。

完整设计见 [docs/ARCHITECTURE_PLAN.md](docs/ARCHITECTURE_PLAN.md)。

## 开发验证

```bash
npm test
```

实验脚本保留在 `src/experiments/`，不属于正式 `runs/` 生产路径。
