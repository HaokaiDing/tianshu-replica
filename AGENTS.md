# TianshuAgent 项目约定

## 默认协作模式

这里的 Orchestrator 可以是任意 Coding Agent，不限定为 Codex。默认角色和权限如下：

- 用户是出品人：确定题材、受众、市场和商业口味，只在规划通过独立审稿后批准最终大纲。
- 外部 Orchestrator 负责编译 brief 和生产合同、调用 CLI、监控状态、读取报告、处理升级并验收交付。它不得直接修改 `runs/<run-id>/canonical/`、`screenplay/`、`storyboard/`、`continuity/` 或 `deliverables/`，也不得把自己写的内容冒充内部 Agent 的修订稿。
- TianshuAgent 是唯一正式创作和修订生产线。Planner、Writer 与 Storyboard Agent 只能在 task workdir 写草稿，经过 `run_checks` 后使用对应 `submit_*` 工具提升正式产物。
- Reviewer 独立运行，只提交 findings，不改稿。窗口 Reviewer 负责举证，全剧 Reviewer 负责最终 Repair Plan 和 P2 处置。
- Runtime 负责状态机、修订轮次、连续性回退与重放、摘要和 stale 传播、并发锁、确定性检查及交付。

默认流程：

```text
init → plan / planning review / planning repair
→ awaiting_approval
→ approve
→ run（screenplay / review / repair / re-review
      → storyboard / review / repair / re-review
      → delivery gate / deliver）
```

用户批准大纲后，外部 Orchestrator 默认只运行或恢复 `tianshu run <run-id>`，不逐集手工干预。任务只有在当前生产合同的硬门全部通过、独立终审 P0/P1 为零、所有 P2 均已修复或标记为 `accepted_non_blocking`、task 与正式文件摘要一致、连续性已接受、delivery gate 通过时才算完成。

语义修订轮次由 `canonical/production-contract.json` 限制，默认每阶段最多 3 轮。P0、已批准大纲或合同冲突、同类问题达到系统性阈值、相同 finding 修后仍存在、摘要或 stale 状态不一致、修订预算耗尽时必须进入 `needs_human_review`。Reviewer 未正式提交或暂时不可用时必须停止并保留 reviewing 恢复点。不要无限重试，也不要绕过质量门手改正式产物。

## 写作风格

遇到“去 AI 味”“说人话”“自然一点”“别像模板”这类中英文改写或审稿任务时，遵循 `.codex/skills/shuorenhua/SKILL.md`。

对外文本优先按该 skill 处理；代码、日志、配置、命令输出和需要保留的固定合同文本不套用该 skill。
