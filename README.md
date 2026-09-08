# Tianshu Replica · 天书大纲复刻

保留源大纲的事件、冲突、反转与跨集承接，由模型补充对白、动作和场景细节，经独立审稿后交付剧本与固定七列分镜。基于 [byfusion/TianshuAgent](https://github.com/byfusion/TianshuAgent) 的生产流程，使用 Kimi + Pi；可运行于满足依赖要求的本机或服务器。

本仓库维护复刻输入、源大纲对照审稿、用量统计和可重复的离线验证，保留上游的原创入口及创作角色分工。运行设备不与 Mac mini 绑定。真实素材、账号配置和生产产物由使用者在本地管理；复刻功能只附带合成样例，既有上游测试样例保留。上游来源保留在 Git 历史中，未为上游代码新增开源许可证。

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

先安装依赖并运行离线测试：

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run test:replication
```

用仓库内合成样例创建一个离线草稿，不调用模型：

```bash
npm run tianshu -- init fixtures/replication-synthetic/brief.txt \
  --title "复刻样例" --episodes 60 \
  --source-outline fixtures/replication-synthetic/source-outline.md \
  --contract fixtures/replication-synthetic/production-contract.json
```

实际生产时换成自己的 brief、大纲与合同，完成下方账号配置后再执行：

```bash
# Planner 与独立 Reviewer 对照源大纲进行规划
npm run tianshu -- plan <run-id>

# 用户批准最终大纲后，进入细节扩写与交付
npm run tianshu -- approve <run-id>
npm run tianshu -- run <run-id>

# 中断后恢复，或只读查看状态与用量
npm run tianshu -- resume <run-id>
npm run tianshu -- status <run-id>
npm run tianshu -- metrics <run-id>
```

普通原创流程沿用 `init brief.md --title "剧名"`，省略 `--source-outline` 即可。

自定义合同：

```bash
npm run tianshu -- init briefs/show.md \
  --title "剧名" \
  --contract contracts/custom-production-contract.json
```

`run` 会取得 run 级 `.lock`，同一个项目不能被两个 Orchestrator 同时生产。新合同默认在全部质量门通过后自动生成 Markdown 和 DOCX；自定义合同可以把 `delivery.autoDeliver` 设为 `false`，让流程停在 `awaiting_delivery_approval`。

## 大纲复刻

有完整源大纲时，用 `--source-outline` 初始化复刻项目。源文件单独保存为 `canonical/source-outline.md`，路线记录为 `tianshu-replication`；普通 `init` 仍走原创路线。初始化只读入文件，不请求模型，也不会批准大纲。

```bash
npm run tianshu -- init brief.md --title "剧名" --episodes 60 \
  --source-outline source-outline.md --contract production-contract.json
```

`brief.md` 写明目标市场、复刻目标和允许的文化适配。源大纲按 `## 第1集` 到 `## 第60集` 排列，也支持纯文本集标题；目前总集数为 30 或 60。模板见 [source-outline.template.md](examples/source-outline.template.md)。每集建议保留核心事件、主冲突、反转、起止状态、尾钩和跨集承接；已有信息写在正文中即可，不强制新增固定字段。程序只检查集号完整、有序且正文非空。

Planner 会保留这些剧情骨架，补齐人物、市场资料和连续性台账，把对白、动作编排和场景细节留给 Writer。原始大纲会完整交给 Planner 和独立规划 Reviewer；后续 Writer 沿用当前集及相邻集的已批准大纲，不重复携带整份源稿。源大纲里的监控、DNA 等既有情节由语义审稿判断，复刻模式不因关键词直接拒绝整集；双语、格式、时长和其它结构检查继续执行。

源大纲与生产合同矛盾时应先明确取舍，不能静默重写源剧情。默认合同为女频、每集 90–100 秒；其他受众或时长须明确传入适合项目的合同。源大纲通过独立审核后，仍需用户批准一次，之后才能 `run`。

### 已有样例与离线验证

[合成 60 集样例](fixtures/replication-synthetic/source-outline.md)用于验证完整集数、源稿保留和自定义生产合同。另有 [合成 30 集样例](fixtures/replication-example.md) 和 [审核正反例](fixtures/replication-review.json)。这些都是测试材料，不代表真实生产或创作质量已经通过验收。

```bash
npm run test:replication
npm test
```

测试覆盖源稿完整保留、规划及修订输入、独立审稿输入、原创路径、分镜内容检查、真实 CLI 初始化、未批准时拒绝生产，以及用量累计。全部使用本地文件或事件样本，不调用模型；通过这些测试不代表创作质量或成本改善已通过真实生成验证。

### 用量与路线对比

```bash
npm run tianshu -- metrics <run-id>
```

该命令只读 `metrics/*.json`，按角色和全任务汇总所有已记录尝试，包含失败、重试及 Planner 各轮。`usageTotal` 是覆盖完整的值；缺报显示 `null`。`usageKnown` 是已观测小计，不能当完整账单。旧记录或没有调用记录时覆盖情况为 `unknown`；缺失的数据不补成零。`wallElapsedMs` 是已记录尝试最早开始至最晚结束的跨度，包含中间空隙，重叠阶段不相加；它不是模型纯执行时间。

使用飞书生产表时，可由表拥有者创建“产出路线”单选列（[字段定义](examples/production-route-field.json)），再选择“天书复刻”或“ReelClaw”。交付物继续使用“剧本交付”“分镜交付”，不要把原先“剧本制作方案”的客户端选项当成路线，也不要把成片进度当剧本验收状态。两路线按同一素材、集数与交付范围比较耗时、token 和人工审阅结果。

## 公司设备环境准备

在公司设备的项目目录使用 Node ≥22.19 和仓库锁定的 Pi SDK 0.84.2，凭据独立放在该设备，不复制个人配置：

```bash
npm ci --ignore-scripts --no-audit --no-fund
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
export TIANSHU_PYTHON="$PWD/.venv/bin/python"
export PI_CODING_AGENT_DIR="$PWD/.pi-company"
npm run check:environment
```

`check:environment` 仅检查本机依赖、磁盘和凭据文件是否存在，不读凭据值，不探测模型节点，也不刷新登录。它的通过只说明依赖就绪，不能证明公司账号已登录或服务器可生产。`TIANSHU_PYTHON` 与 `PI_CODING_AGENT_DIR` 也需保留在实际生产进程的环境中。

公司账号可在仓库内运行 `./node_modules/.bin/pi`，然后执行 `/login kimi-coding`，按 **Sign in with Kimi Code** 完成设备码授权。Pi 也支持公司 `KIMI_API_KEY`；既有 `auth.json` 优先于该环境变量，因此应使用独立公司凭据目录，并确认登录身份。不要把密码、Key 或授权码写入 brief、Git 或日志。上述目录已忽略提交。

首次生产前确认素材、目标市场、集数、交付范围及账号预算，再审核最终大纲。离线测试不会发起模型请求；实际质量、耗时和 token 节省需由同一素材、同一交付范围的真实样例验证。

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
