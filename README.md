# TianshuAgent

TianshuAgent 用 Pi Coding Agent SDK 把短剧创意推进到固定 7 列分镜剧本（ReelClaw 格式）。

它保留旧天书的内容方法和人工审核门，把模型调用换成受约束的 Agent：Agent 可以按需读取项目资料、在任务工作区修改草稿、做有限研究和自检；正式产物只能通过校验工具提交。

默认模型是 `kimi-coding/k3-256k`。剧本和分镜按连续 5 集复用一个 session；项目事实仍保存在文件 artifacts 里，不依赖 session 历史。

最终交付只有：

- `<剧名>｜分镜剧本.md`
- `<剧名>｜分镜剧本.docx`

完整设计见 [docs/ARCHITECTURE_PLAN.md](docs/ARCHITECTURE_PLAN.md)。

## 开发中的实验

仓库保留了 Pi session、artifact、研究、Repair Plan 和 Word 表格渲染的实验脚本。它们写入 `experiments/`，不影响正式 `runs/`。

```bash
npm run experiment:session -- --mode smoke --arm both
npm run experiment:session -- --mode full --arm both --replicate 2
```

## 当前 CLI

```bash
npm run tianshu -- init <input> --title "剧名"
npm run tianshu -- plan <run-id>
npm run tianshu -- approve <run-id>
npm run tianshu -- produce <run-id>
npm run tianshu -- storyboard <run-id>
```

`plan` 完成后会停在人工审核门。只有 `approve` 后才能继续生成剧本和分镜。
