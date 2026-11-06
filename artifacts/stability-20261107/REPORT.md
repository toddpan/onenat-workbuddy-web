# 线上稳定性测试报告（2026-11-07 06:53–07:05 +08:00）

- 环境：https://natpass.yikaihui.com/onenat-workbuddy（阿里云）
- 版本：2026.11.1（健康，测试开始时 uptime 2148s）
- 结论：**稳定性 PASS** —— 全程 0 个 5xx / 0 个失败事件；brain 节点上游已恢复

## S1 只读高频
- healthz ×60 顺序：60/60 成功，avg 79ms，max 851ms（单次抖动，隧道级），0 错误（s1-healthz.log）
- 混合读并发 6轮×8（monitor/task list/project list/resource dsh/task_status/healthz）：48/48 成功，avg 241ms，0 错误（s1-burst.log）

## S2 数据面回环
- 项目生命周期 ×2：create → 同节点同路径 409 CONFLICT → delete，2/2 ✅
- 文件回环 upload→download→delete ×3 + 干净复验 ×1：sha256 三步全一致，4/4 ✅
  （首轮脚本 grep 误报 FAIL：紧凑/美化 JSON 格式差异，非服务故障，已人工复核）
- draft 任务生命周期 ×2：create(draft) → delete，2/2 ✅

## S3 派发稳定性（真实模型任务）
- @136-苦力兔：completed，回「STAB-136-OK」✅
- @brain-苦力兔：completed，回「STAB-BRAIN-OK」✅
- brain 主会话直发（gpt-6.1-sol，早间空流路径复测）：completed，回「STAB-BRAIN-MAIN-OK」✅
  → **早间 brain 节点上游空流问题已恢复**（主会话/成员会话/136 节点全路径正常）

## S4 监控窗口对比
- 窗口 14min 内事件 6 条，全部 task_completed/subtask_completed，**0 失败/异常事件**
- 结束时 KPI：18/21 在线，failedToday=0

## 发现与运维须知（非缺陷）
1. **MCP 通道幂等回放窗口（10 分钟）**：同一 MCP 会话内完全相同的 tools/call（按参数哈希）
   在 10 分钟内回放首次结果快照。本次删除后的同参 keyword 查询持续回放删除前快照，
   直连 HTTP /api/tools/* 与新 MCP 会话均为实时数据（已实测闭环）。
   建议：删除核验/严格轮询场景改走 HTTP 通道或强制新会话（wbmcp rm workbuddy-mcp.sid）。
2. 136 节点 /tmp/wb-verify-11070632 空目录残留（首轮验收所建，/tmp 无害）。

## 清理核验
- 稳定性测试产生的 5 个任务、3 个项目全部删除；全量任务列表 309 条，0 条残留（直连 HTTP 复核）。
