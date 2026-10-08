# 子技能：文件与资源（file_manage / resource_manage / ssh_resource_manage）

## 文件交互

`file_manage`：list / mkdir / upload / download / delete（子智能体工作区文件，`agent` 参数指定归属）。

- `upload`：`contentBase64`（≤1MB）或 `url`（服务器代拉 ≤10MB）。
- `download`：返回文本或 base64（≤8MB）。

## 资源目录（resource_manage）

ONENAT 平台的隧道/映射是唯一资源来源，以稳定 ID 标识；端口会漂移，**勿缓存公网 URL**。

- `list`：全部资源（SSH / DSH / HTTP 应用，含实时解析的公网入口）。
- `dsh`：只列 DSH 算力节点——`nodeRef` / 建 sub agent / 建项目要映射 ID 时用这个。
- `resolve`：解析单个映射当前入口（`mappingId` 参数）。
- `refresh`：强制刷新目录。

## SSH 资源池（ssh_resource_manage）

WorkBuddy 自管的 SSH 凭证池（与 ONENAT 隧道映射互补）：list / get / upsert / delete / test / exec。

- `exec` 在目标机器远程执行命令——**危险操作**：先确认目标与路径，凭证不进无关输出。
- 凭证模式推荐 `self-fetch`（凭证由子智能体在远端自取，不落任务提示词）。
