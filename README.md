# Tianshu Replica · 原片材料提取与剧本重写

Tianshu Replica 是供短剧创作者在本机使用的 CLI：先根据原片提取创意、人物小传、分集大纲，再由天书依据这三份材料重写剧本；人物名字和细节允许略微迁移，身份关系、剧情骨架和已知事实保持对应。基于 [byfusion/TianshuAgent](https://github.com/byfusion/TianshuAgent)，本机负责流程和文件，模型推理由远端 Kimi 完成。

本仓库维护复刻输入、源大纲对照审稿、用量统计和可重复的离线验证，保留上游的原创入口及创作角色分工。默认按需在本机运行，不自动部署 Mac mini 或安装常驻后台服务。真实素材、账号配置和生产产物由使用者在本地管理；复刻功能只附带合成样例，既有上游测试样例保留。上游来源保留在 Git 历史中，未为上游代码新增开源许可证。

当前视频提取入口尚未完成真实原片的端到端验证。此前三集小样使用已有原片分析 DOCX，验证了文本大纲到剧本、分镜与文档交付；这不能替代原片直读或三份材料提取的真实验收。离线测试也不能证明创作质量或 token 节省。

新项目默认使用女频竖屏短剧合同：30 集、每集 90–100 秒、12–24 镜，EP1–3 必须有前三秒冷开和可剪宣发桥段。合同保存在 `canonical/production-contract.json`，可以在初始化时传入自定义 JSON。

## 默认工作流

```text
原片分集视频 → 提取创意、人物小传、分集大纲
→ 三份源材料 + brief
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

使用 Node ≥22.19，克隆仓库后安装依赖并运行离线测试：

```bash
git clone https://github.com/HaokaiDing/tianshu-replica.git
cd tianshu-replica
npm ci --ignore-scripts --no-audit --no-fund
npm run test:replication
```

用仓库内已有大纲的合成样例创建一个离线草稿，不调用模型。这个兼容入口只演示初始化；完整三份材料流程见下方“三份源材料与重写”：

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

## 三份源材料与重写

提取阶段分别记录创意、人物小传和分集大纲，并保留来源与未知项；重写阶段允许一致地略微调整人物名字和细节。人物身份、关系和剧情骨架须有对应依据，避免只凭简短大纲另造人物身份。

三份材料以 JSON 包传递，字段为 `creative`、`characters`、`outline`、`provenance`。初始化时分别原样存入 `canonical/source-creative.md`、`source-characters.md`、`source-outline.md`；Planner 与独立规划 Reviewer 同时读取三份材料。缺一项会在创建项目之前报错。

### 原片输入

`extract-video` 接收明确集序的 MP4 清单；路径相对清单文件解析，不猜测整部合辑的分集边界：

```json
{"episodes":[{"episode":1,"path":"ep-01.mp4"},{"episode":2,"path":"ep-02.mp4"},{"episode":3,"path":"ep-03.mp4"}]}
```

```bash
npm run tianshu -- extract-video inputs/episodes.json --preview
npm run tianshu -- extract-video inputs/episodes.json --output inputs/source-materials.json
```

按一集一次、串行使用 Kimi Code `k3` 的原生视频接口，提完释放该集请求；Pi 的 `k3-256k` 继续负责后续文本创作。[Kimi 官方视频输入说明](https://www.kimi.com/code/docs/third-party-tools/hermes.html#第三步-启用视频分析)。当前 Pi SDK 输入仅支持文本和图片，视频不伪装为图片。每个文件上限 32 MiB 是本工具的本地内存预算，不是供应商的文件限制；视频过大时先明确裁切或压缩方案，不自动降低画质。没有本地模型和默认转码。尚未取得并通过真实原片验证时，只能报告接口与离线检查完成。

### 已有文本证据输入

已有原片分析、字幕整理或剧本 DOCX 时，可从文本提取同样三份材料；这条路径会明确记为文本证据，`directVideoUnderstanding=false`，不能声称重新看过原片：

```bash
npm run tianshu -- extract-source inputs/source.docx --episodes 3 --preview
npm run tianshu -- extract-source inputs/source.docx --episodes 3 --output inputs/source-materials.json
```

每批最多三集，保留原名、关系疑点、倒叙和集界。多批次只汇总创意与人物材料，已提取的逐集大纲保持顺序。提取使用简短材料，不套用旧版 30 KB 人物稿门槛。已有输出或提取记录时拒绝覆盖，失败用量仍计入。

### 交给天书重写

```bash
npm run tianshu -- init inputs/brief.txt --title "三集验证" \
  --sample --source-episodes 50 \
  --source-materials inputs/source-materials.json \
  --contract inputs/production-contract.json
npm run tianshu -- plan <run-id>
```

大纲批准后可通过本地队列继续创作。默认 `run` 沿用现有剧本与分镜交付流程；只需先查看完整剧本时，可用 `produce` 与 `review` 分阶段执行，不必为验收三份源材料重跑已完成的分镜。

## 已有大纲入口

`extract-outline` 与 `--source-outline` 保留给已有大纲场景，它们不代表已完成创意、人物小传和分集大纲三项提取。

### 从原剧本文本或已有分镜提炼大纲

输入支持按集排列的 Markdown、TXT 和 DOCX。DOCX 读取使用 Python 标准库，保留正文、表格与播出集序；不会直接理解视频。已有原片分析分镜可以作为输入，但应注明它是原片分析的派生材料。

```bash
# 只检查分集、范围和输入长度，不调用模型、不创建提炼任务
npm run tianshu -- extract-outline inputs/source.docx --episodes 3 --preview

# 调用已配置的 Kimi，提炼原剧前三集
npm run tianshu -- extract-outline inputs/source.docx --episodes 3 \
  --output inputs/source-outline.md
```

提炼按每三集顺序执行，只保留核心事件、主冲突、反转、结尾状态和钩子，同时保留来源依据与疑点。缺失信息写“未知”；人物别名矛盾和倒叙原样保留，不编造身份映射、不重排故事时间。每集约 150–300 个中文字符是压缩目标，不能为了缩短而删掉关键事实。

原文快照、各批结果与用量写在 `<output>.extraction/`，全部批次成功后才产生指定的大纲文件。已有输出或记录目录时拒绝再次执行，避免不知情地重复调用；失败后的中间结果留在原目录供检查，当前入口没有自动恢复或覆盖行为。

### 三集小样

```bash
npm run tianshu -- init inputs/brief.txt --title "小样名称" \
  --sample --source-episodes 50 \
  --source-outline inputs/source-outline.md \
  --contract inputs/production-contract.json
```

`--sample` 明确创建原剧第 1–3 集的独立样例，`--source-episodes` 记录已确认的原剧总集数，未知时省略。正式生产仍使用 30/60 集入口。小样沿用规划、独立审稿、大纲批准、剧本、分镜和交付流程，不补占位集；第三集可以保留未解冲突或倒叙，不被要求写成全剧结局。状态、审稿与用量报告、Markdown/DOCX 均标明样例范围。

生成规划并经独立审稿后，用户仍须批准最终大纲，才能执行 `run`。素材对应的目标市场、单集时长与最终交付类型应在小样开始前确定。

规划已正式提交、但审稿调用或结果接收失败时，重新执行 `plan <run-id>` 会复用该轮已完成的规划，只重试审稿。终审工具会在接收时校验 P2 的处置字段，缺失时要求 Reviewer 补齐，避免先接受后在流程外报错。

小样的窗口审稿和终审各设 5 分钟等待上限。窗口审稿成功后立即保存结果；恢复同轮审稿时，只有完整材料和审稿指令均未变化才复用，避免终审中断后重复支付已完成的窗口审稿。超时会保留当前产物和 reviewing 状态，不视为审稿通过。

对已经阻断的剧本审稿，如有明确源证据或规则层级错误，可用 `review <run-id> --note inputs/review-note.txt` 请求有据复核。意见会留在新报告中，Reviewer 仍须核对正文；此命令不改剧本、不重置修订预算。新结果若为 `repair`，先执行 `repair <run-id>` 再 `run <run-id>`，由 Writer 定向修订。此前仅被阻断、尚未修订的问题，不会被误算成“修后仍存在”。

分镜对应入口为 `storyboard-review <run-id> --note inputs/review-note.txt`，支持复核尚未执行的修订要求或已阻断的分镜审稿。对源稿有意保留的身份、时间疑点，审稿不能以新增幕后事件或身份关系作为修复条件。

### 使用已有大纲

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

该命令只读 `metrics/*.json`，按角色和全任务汇总所有已记录尝试，包含失败、重试及 Planner 各轮。`usageTotal` 表示已记录消息中字段完整的用量；缺报显示 `null`，`usageKnown` 保留已观测小计。`usageCoverage` 只覆盖 assistant 消息，`promptRequestCoverage` 另记录每次 `session.prompt` 的成功、失败、超时和重试；一次 prompt 可以包含多次模型请求。原始 provider 请求总数与账单金额没有观测时保持未知，不能把消息字段齐全称为整条路线精确计费。

提纲提炼的用量位于 `<output>.extraction/metrics/`，须与后续写作、审稿及分镜一起计入本次路线；使用历史大纲时，其历史提炼成本未知，不能当零。原始 usage 与模型名称均保留，不自行推断缓存是否包含在 input 或 reasoning 是否包含在 output。

`wallElapsedMs` 是已记录尝试最早开始至最晚结束的跨度，包含中间空隙，重叠阶段不相加；它不是模型纯执行时间。与 ReelClaw 对比时须统一来源集段、市场、时长、交付类型和计时起止；没有同范围的实际对照结果就报告未知，不计算节省百分比。

使用飞书生产表时，可由表拥有者创建“产出路线”单选列（[字段定义](examples/production-route-field.json)），再选择“天书复刻”或“ReelClaw”。分别记录路线、剧本交付、分镜交付和人工审阅状态，成片进度不能代替剧本验收。两路线按同一素材、集数与交付范围比较耗时、token 和人工审阅结果；CLI 不会自动修改生产表。

## 本机环境与按需运行

### 本地自动生产

后台入口使用 Node 标准库读取 `.queue/` 中的任务，每次最多启动一个创作进程。空队列立即退出，实际生成才加载 Pi SDK；模型运行于远端 Kimi。人物继续保存在 `canonical/characters.md`，分集骨架在 `outline.md`，身份和连续性由 `ledger.json` 与连续性快照承接，不另建人物数据库或常驻 Web 服务。

旧版天书值得沿用的是人物关系、分集状态变化与相邻集接缝；其人物文件最低 30 KB 的长度规则及并发节点池不适合作为本项目的轻量目标。[旧版人物输入](https://github.com/byfusion/tianshu/blob/main/drama-skills/src/prompts.js#L143)、[旧版长度规则](https://github.com/byfusion/tianshu/blob/main/drama-skills/src/status.js#L22)。

先用现有 `init` 创建带明确素材、大纲和生产合同的 run，再显式入队：

```bash
npm run worker -- enqueue <run-id>
npm run worker -- status
npm run worker -- once
```

草稿入队后自动规划，停在大纲批准处。执行 `npm run tianshu -- approve <run-id>` 后，再次运行本地 worker 即可继续剧本、修订、分镜与交付。生成完成的队列状态为 `awaiting_producer_review`：制作人在开制作前自行审改，AI 终审与本地导出不代表制作人已审核。

失败任务保留恢复点并停为 `failed`，处理实际原因后显式执行 `npm run worker -- retry <run-id>`。后台不会每分钟重复失败的模型请求。`needs_human_review`、大纲批准和交付批准状态都会暂停；每个 run 的锁也始终保留原有 `lock-status / unlock-stale` 处理流程。队列完成后，由使用者把文档交到选定的交付位置，并单独记录人工审阅结果。

默认不安装 launchd 或其它常驻服务。`worker once` 完成一个任务、失败或等待人工后退出；空队列时只短暂读取 JSON，不加载 Pi SDK。仓库中的 launchd 配置生成脚本不会自行安装或启动服务；Mac mini 部署需要另外配置和授权。

`PI_CODING_AGENT_DIR` 必须显式指定已授权的 Kimi 配置，凭据值不写入队列。空闲检查的短暂开销与真实生成峰值要分别测量；视频 Base64 和会话上下文都会产生临时内存，不能把空队列 RSS 当作整剧峰值。

在本机项目目录使用 Node ≥22.19 和仓库锁定的 Pi SDK 0.84.2，凭据独立放在该设备，不复制个人配置：

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
