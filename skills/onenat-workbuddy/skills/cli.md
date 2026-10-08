# 子技能：无工具宿主用 wb.mjs（命令行通道）

宿主没有工具通道（不能直接调 workbuddy_* 工具）时，用 `wb.mjs` 脚本走 HTTP 工具通道。所有命令都是 `POST /api/tools/:name` 的薄封装，语义与工具一致。

配置在 `~/.workbuddy-skill.json`（安装时写入），或环境变量 `WORKBUDDY_BASE_URL` / `WORKBUDDY_TOKEN`。

```bash
wb.mjs monitor overview                          # 全局态势
wb.mjs resource dsh                              # 可用 DSH 节点（拿映射 ID）
wb.mjs expert list --skill 审查                  # 专家库检索（--domain 分区 / --limit --offset 翻页）
wb.mjs expert create --json '{"id":"my-checker","name":"检查员","systemPrompt":"…"}'   # 建用户专家
wb.mjs task create --title x --message "…" --node <映射ID>          # 指定任务节点
wb.mjs project list                              # 项目列表
wb.mjs task create --title x --project proj-x --message "…（可 @sub agent）"   # 项目任务
wb.mjs task wait --id task-xxx --timeout 300000  # 等结果
wb.mjs schedule upsert --json '{…}' | planner set --agent agent-x --model deepseek/deepseek-v3
wb.mjs file download --agent agent-x --path /w/a.txt --out ./a.txt
```

完整命令：`wb.mjs help`。安装：`curl -fsSL <服务地址>/onenat-workbuddy/install-skill.sh | bash -s -- --base-url <服务地址>/onenat-workbuddy --token <APIKEY>`。

安装脚本默认装到本机全部 AI 技能目录（DSH / ZCode / Claude）；`--dir dsh|zcode|claude|路径` 可指定。`wb.mjs tools` 做连通性自检。
