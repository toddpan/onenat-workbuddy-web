# onenat-workbuddy-web 评审基线（Review Baseline）

> 生成时间：2026-10-15（公司笔记本节点只读盘点）
> 工作目录：`/Users/tsbj/feyanggit/DHS-test/onenat-workbuddy-web`
> 用途：为后续各专项评审提供统一基线。假设与事实分区书写，缺口仅作假设记录，未虚构。

---

## 1. 技术栈与关键依赖（事实）

| 项 | 值 | 来源 |
|---|---|---|
| 项目 | OneNat WorkBuddy — 独立部署的多智能体协作 WEB 服务 | package.json |
| 版本 | `2026.10.15`（日期版本号） | package.json |
| 语言/运行时 | TypeScript（ESM，`"type": "module"`），Node ≥ 20 | package.json engines |
| 本机工具链 | node v26.7.0 / pnpm 11.22.0（实测 `--version`） | 实测 |
| 运行时依赖 | `ssh2 ^1.17.0`（SSH 资源 test/exec，可选）、`undici ^7.0.0`（SSE chunk 间超时，可选）——缺失自动降级 | package.json + docs/standalone-deploy.md |
| devDependencies | `typescript ^5.9.0`、`@types/node ^24.13.3` | package.json |
| HTTP 宿主 | Node 原生 `http`，**零 DSH 依赖**（不 import cordis / `@deepseek-ai/*`） | docs/standalone-deploy.md |
| 构建 | `bash scripts/build-standalone.sh`（仅 tsc，产物 `dist/server.js`） | package.json scripts |
| 数据目录 | `~/.onenat-workbuddy`（`--data` / `$WORKBUDDY_HOME` 可改） | README / docs |
| 包管理 | `pnpm-workspace.yaml` 存在但仅含 `allowBuilds`（ssh2/cpu-features，值为占位文本"set this to true or false"）；`pnpm-lock.yaml` 未提交（git untracked） | 实测 |

## 2. 目录结构概览（事实）

```
src/            服务端源码（约 30,032 行 TS），核心：
  server.ts     入口装配；router.ts 路由；engine.ts 引擎；orchestrator.ts（含单测）
                Planner/DAG 相关：expert-registry / expert-store / expert-teams / prompt-composer / resolver
                数据面：store.ts（落盘）、auth.ts、ssh-store/ssh-resources、scheduler.ts、usage.ts、monitor.ts
  web-ui.ts     控制台前端（单文件约 11,268 行，评审重点/热点）
  mcp/          expert-mcp.ts（MCP 通道）
  *.test.ts     orchestrator.test.ts、interaction-guard.test.ts（node:test）
skills/         onenat-workbuddy / workbuddy-mcp 技能包（随包发布）
assets/         expert-roster 专家名册（zh）
scripts/        构建/部署/冒烟/e2e 脚本（约 25 个 .mjs/.sh/.cjs）
docs/           4 篇实现/部署文档（见 §4）
dist/           构建产物（已存在且可重新生成）；dist-test/ 单测编译产物
e2e-artifacts/  流式测试脚本
根目录散件       Dockerfile、tsconfig.server.json、README.md、
                dsh-web-service-install-plan.md、3 张 png 截图（untracked）
out/            untracked（来源未查，见缺口）
```

## 3. 入口文件与启动方式（事实）

- **入口**：`dist/server.js`（由 `src/server.ts` 编译；`package.json` `main` 与 `bin.onenat-workbuddy` 均指向它）
- **启动**：`node dist/server.js --port 3081 --onenat-base-url <url> --onenat-api-key onk-xxx`
- 控制台 `http://127.0.0.1:3081/onenat-workbuddy`，健康检查 `/healthz`
- 登录鉴权默认开启（HttpOnly Cookie，7 天滑动过期）；默认只监听 127.0.0.1

## 4. 既往评审 / 方案 / 改动记录材料（事实，路径可查）

**未发现既往"代码评审报告"类文档**（docs/ 下 4 篇均为实现/部署文档，无 review 记录）→ 本次按**首次评审**处理。

已有方案/分析与改动痕迹材料：

| 路径 | 性质 |
|---|---|
| `docs/standalone-deploy.md` | 独立部署指南（构建/启动/systemd/Docker/nginx/安全边界） |
| `docs/streaming-integrity.md` | 流式内容显示不全的根因分析与修复记录（含定位方法、回归测试） |
| `docs/attachment-p2p-upload.md` | 附件 P2P 直传实现文档（架构/控制面 API/演进史，2026-10-14 上线） |
| `docs/skills-management-design.md` | 技能管理 + 子智能体技能绑定设计（历史形态，已按新形态落地） |
| `dsh-web-service-install-plan.md` | 相邻仓库 dsh-web-service 的安装方案（规划性质，非本仓库代码） |
| `README.md` | 架构说明、配置、移动端适配要点 |
| git log（HEAD=`d1f96ac`，2026-10-15） | 最近改动：流式下载空闲超时修复、公司信息清理、MCP 技能入库、上传直连回退、P2P 直传重构等 |
| git untracked 文件 | `image.png / image-1.png / image-2.png`、`out/`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`（工作区无未提交的源码改动，仅上述散件） |

TODO 痕迹：`src/monitor.ts` 中有 2 处 `TODO`（其余 src/*.ts 为 0）。

## 5. 构建 / 运行 / 测试命令验证（公司笔记本节点实测）

| 命令 | 结果 | 证据 |
|---|---|---|
| `npm run typecheck`（tsc -p tsconfig.server.json --noEmit） | ✅ 通过，exit 0 | 实测 |
| `npm run test:unit`（编译 2 个 .test.ts 后 node --test） | ✅ 35/35 通过 | 实测输出 `pass 35 fail 0` |
| `npm run build`（bash scripts/build-standalone.sh） | ✅ 通过，产出 `dist/server.js`（仅写 dist/，未改业务代码） | 实测 |
| `npm run smoke`（自带 mock ONENAT，无需外网） | ✅ 51/51 通过 | 实测输出 `全部通过（共 51 项）` |
| `npm start`（node dist/server.js） | ⚠️ 未实际执行（会拉起常驻服务并占用 3081 端口，属运行行为而非盘点范围）；产物存在且 `node dist/server.js --help` 类启动路径已由 smoke 覆盖（smoke 以子进程方式真实拉起过服务） | 假设/边界说明 |
| `npm run smoke:e2e`、各 `smoke:*`、`test:streaming*`、e2e 脚本 | ⚠️ 未执行：需真实 ONENAT / DSH 远端环境或真实派发凭据，避免无人值守阶段产生外部副作用 | 不可执行原因（环境依赖，非命令损坏） |
| `pnpm install` | 未执行（node_modules 已存在，命令均可跑通，无需重装）；`pnpm-workspace.yaml` 的 allowBuilds 为占位文本，若重装需先补全为 true/false | 假设/边界说明 |

## 6. 材料缺口与假设（仅假设记录，未虚构）

1. **假设：既往评审记录缺失** —— 未发现 review 报告/CHANGELOG，按首次评审处理。
2. **假设：`out/` 目录来源不明** —— git untracked，未盘点其内容用途；不影响 src 评审，但建议后续确认是否应入 .gitignore。
3. **假设：`pnpm-workspace.yaml` 的 allowBuilds 值是未完成的占位文本**，可能在干净环境 `pnpm install` 时阻塞 ssh2 的构建脚本；本机已装依赖故未复现。
4. **缺口：设计总文档在另一仓库** —— README 指向 "ngrok 仓库 docs/onenat-workbuddy-design.md"，本工作区内不存在，无法核对其最新性。
5. **缺口：无 CI 配置、无 lint 配置** —— 仓库内未见 .github/、eslint/prettier 配置；代码质量约束不明，列为评审假设基线。
6. **缺口：e2e/smoke 全家桶未在本次执行**（需真实远端凭据），其可执行性仅由 package.json 声明 + smoke 主套通过间接佐证。
7. **假设：`web-ui.ts` 单文件 11,268 行**为前端唯一载体（未见独立前端工程/框架），评审时可按"无构建前端"对待——该结论基于目录清单，未逐行核实。
8. **缺口：测试覆盖面** —— 单测仅覆盖 orchestrator 与 interaction-guard 两个模块，其余约 30k 行源码无自动化测试，属已知事实型缺口。
