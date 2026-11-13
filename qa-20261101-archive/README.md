# QA 截图归档（2026-11-01 收口时整理）

树上遗留的 4 张散落截图（`image*.png`，docs/review-baseline.md 曾记录为未入库散件）按内容归档于此：

| 文件 | 内容 | 说明 |
|---|---|---|
| 01-win-workdir-reject-old-toast.jpg | 子智能体编辑保存报「工作目录必须是绝对路径（以 / 开头）」 | 旧版文案。Windows 盘符/UNC 路径支持已于 `f8a262f`（2026.10.28）上线（`isNodeAbsolutePath` + 前端 `isNodeAbsDir`）；2026-11-01 线上实测 `workDir=C:\Users\panzuji` 已可正常保存 |
| 02-backlog-enter-workbench-entry.jpg | 待办页「进入工作台」项目入口标注 | 对应 task-8（添加进入项目工作台的入口），入口已实现 |
| 03-workspace-search-workbuddy.webp | 工作台任务会话搜索「workbuddy」效果 | 历史验收证据（image-1 与 image-2 逐字节相同，仅保留一份） |

均为历史版本时期截图，现存线上行为以 2026-11-01 部署版为准。
