---
id: task-94
title: qwen38 正文与 usage 故障：旧凭据导致 401，尚未修复验收
status: Done
assignee:
created_date: '2026-11-09T10:33:44Z'
updated_date: '2026-11-09T11:47:58Z'
labels:
  - bug
  - qwen38
  - integration-blocker
dependencies:
ordinal: 94000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
2026-11-09 证据汇总，未完成，不可部署。目标模型 qwen38/qwen3.8-27b。依据注入的诊断、实现、独立审查与 brain 验证摘要；本轮不访问 brain、不下载凭据。
根因：上游已证实 DSH credentials.resolve 优先命中 qwen38 旧钥，OneAPI 返回 401；不是已证实的 SSE 解析缺陷。OneAPI 同参直连正常，正文 4、usage 19/2/21。
实现结果：指定 WorkBuddy 工作区不含 DSH llm-pi-ai/凭据解析/聚合源码；没有功能补丁或新增修复版本，原始响应夹具未注入本地。WorkBuddy 基线 2cb6fa524c0d750bc6f68996c334cd54f4212b3b；保留已有脏工作区。
审查 sub-078585be：P0 不通过，无可审查/可应用补丁，目标 DSH fcc0ad4621 在该仓库不存在。类型检查 npm run typecheck 退出码 0，仅为 WorkBuddy 基线，不能证明修复。
brain 验证 sub-6cb1f03c：原始请求 max_tokens=40、Reply with just the number 4 仍 HTTP 200、content 为空、usage 全 0；实例 DSH 0.2.2-rc.1 @ fcc0ad4621、pid 2817078 未变，凭据未修改。流式修复后正文/真实 usage、预算验证、其他 provider 回归均未验证；没有包含修复的运行版本。
证据引用：实现交接 artifacts/qwen38-handoff-20261109.md；诊断 sub-87e99b01；独立审查 sub-078585be；brain 验证 sub-6cb1f03c。brain 原始 REPORT.md、reproduce.sh 与四份脱敏响应夹具据上游保留于 /data/panzj/kb-bug-analyzer/qwen38-fixtures/，本节点未读取。
待修复：由具备 brain 运维授权的执行者仅更新 qwen38 凭据，保持其他 provider 凭据和路由不变；上游报告凭据实时读取无需重启，仍须实际验证。修正后复跑 JSON/SSE、最终正文、真实非零 token、终止标记、max_tokens=40 与其他 provider 回归，并记录实际版本和脱敏证据。若鉴权成功仍失败，再在正确 DSH 仓库定位。不得将 reasoning 当正文，不提交密钥。
本条仅记录未完成故障与后续验收，不标 Done、不伪造平台自动回写状态。
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 仅修正 qwen38 凭据或经证实的实现路径，其他 provider 配置及默认行为不变
- [ ] #2 brain DSH 非流式返回非空最终正文与真实非零 usage
- [ ] #3 brain DSH 流式返回非空正文 delta、正常终止并保留真实非零 usage
- [ ] #4 max_tokens=40 原请求与有界预算验证通过
- [ ] #5 独立审查无阻断，其他 provider 回归通过，记录实际运行版本与脱敏证据
<!-- AC:END -->

### 2026-11-09T11:46:55Z 派发为任务
task-92713533 · mode=chat · 成员=1

### 2026-11-09T11:47:58Z 派发执行（成功）
任务 task-92713533 · 结果=成功
我会先核对本地交接材料、仓库状态和相关实现范围，遵守本轮不访问 brain、不下载凭据的限制。将按已加载的 dsh-web-service 技能和 diagnosing-bugs 诊断流程核验证据，保留现有工作区改动，不把基线检查当作修复验收。

**task-94 仍未修复，当前不可部署，5 项验收均不能勾选。** 本轮完成了本地材料与实现范围核查，没有访问 brain、下载或修改凭据，也没有修改源码、部署或手工回写待办状态；已有工作区改动全部保留。

核查结果：

- 当前 HEAD 为 `2cb6fa524c0d750bc6f68996c334cd54f4212b3b`，与交接基线一致。
- [交接说明](/Users/tsbj/feyanggit/DHS-test/onenat-workbuddy-web/artifacts/qwen38-handoff-20261109.md)和 [task-94](/Users/tsbj/feyanggit/DHS-test/onenat-workbuddy-web/backlog/tasks/task-94%20-%20qwen38-正文
