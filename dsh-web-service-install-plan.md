# dsh-web-service 本地 macOS 安装与启动方案

## 关键结论（先读）

`dsh-web-service` **不是一个独立可运行的 Web 服务进程**，它是一个 **DSH Cordis Host 插件**：

- `src/index.ts` 里 `export const inject = ['webServer', 'tools']`，`apply()` 通过 `ctx.webServer.register({kind:'prefix', path:'/api/v1', ...})` 把自己的路由**挂到 DSH 宿主已有的 webserver（默认端口 3080）上**，并注册一个 `dsh_web_service_info` 模型 Tool。
- `package.json` **只有 `build` 和 `typecheck` 两个脚本，没有 `start`/`dev`**。所以传统意义的"启动命令"在这里 = **把插件挂载进一个 DSH profile 并重启 DSH**（标准方式），或**用 dsh-super-injector 热注入**（免重启方式）。
- **不需要 `npm install`**：所有 peer 依赖（`cordis`、`schemastery`、`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-tools` 等）都由 DSH 源码 checkout 提供，`build.sh` 自动做 symlink（已在本机 `node_modules/` 里预建好）。无 lockfile，包管理无约定差异。
- 本机现状（已探测）：`/Users/tsbj/feyanggit/DHS-test/dsh-web-service`，node v26.7.0，pnpm 11.7.0，`DSH_CHECKOUT` 自动探测到 `/Users/tsbj/feyanggit/deepseek-harness`（`packages/` 与 `node_modules/.bin/tsc` 均存在），`lib/` 已有一份历史构建产物。

> 本方案只做规划，不执行任何命令。下面所有命令都是"将要执行"的规划文本。

---

## 1) 依赖安装命令

**结论：无需包管理器安装步骤。** 依赖全部来自 DSH checkout，由构建脚本 symlink 解决。

| 项 | 说明 |
|---|---|
| 包管理器 | 无 lockfile（pnpm/npm/yarn 均无）。构建走 `bash scripts/build.sh`，不读取任何 lockfile。 |
| 是否需要 `npm install` / `pnpm install` | **否。** `build.sh` 会把 `node_modules/@deepseek-ai/*`、`node_modules/cordis`、`node_modules/schemastery`、`@types/node` 等 symlink 到 DSH checkout 对应目录。 |
| 前置硬依赖 | 一个可用的 DSH 源码 checkout（提供 `packages/`、`vendor/`、`node_modules/.bin/tsc`）。本机已存在。 |

规划命令（仅构建需要 checkout，无需装包）：

```bash
# 无需 npm/pnpm install。
# 如需显式指定 checkout（本机已可自动探测到，通常无需设置）：
export DSH_CHECKOUT=/Users/tsbj/feyanggit/deepseek-harness
```

验收标准：
- [ ] `ls /Users/tsbj/feyanggit/deepseek-harness/packages` 有输出（checkout 存在）。
- [ ] 无需执行 `npm/pnpm install`；若误装，`node_modules/` 下应仍是 symlink（指向 checkout），而非真实包目录。

---

## 2) 构建命令

```bash
cd /Users/tsbj/feyanggit/DHS-test/dsh-web-service
bash scripts/build.sh
```

行为（来自 `build.sh` 源码）：
1. 探测 `DSH_CHECKOUT`（env → 常见路径，本机命中 `/Users/tsbj/feyanggit/deepseek-harness`）。
2. 把 `node_modules/{cordis,cosmokit,schemastery,@deepseek-ai/*,@types/node,@standard-schema/spec}` 重建为指向 checkout 的 symlink。
3. 用 checkout 的 `tsc`（`$DSH_CHECKOUT/node_modules/.bin/tsc`）按 `tsconfig.json`（target ES2023 / module NodeNext / outDir `lib` / declaration）把 `src/` 编译到 `lib/`。

可选（类型检查，不产出文件）：

```bash
cd /Users/tsbj/feyanggit/DHS-test/dsh-web-service
./node_modules/.../tsc -p tsconfig.json --noEmit   # 即 package.json 的 "typecheck"
# 等价：npx tsc -p tsconfig.json --noEmit  （tsc 由 checkout 提供，可直接用 node_modules/.bin/tsc）
```

> 注意：本机 `lib/` 里混入了历史 `.bak-*` 文件（`streaming.ts.bak-*`），属脏数据，不影响构建；如介意可清理。

验收标准：
- [ ] 命令输出 `=== Build complete ===`，退出码 0。
- [ ] `lib/index.js`、`lib/router.js`、`lib/*.js` 重新生成且时间戳为本次构建。
- [ ] `lib/types/index.d.ts`（declaration）存在。
- [ ] `node -e "import('/Users/tsbj/feyanggit/DHS-test/dsh-web-service/lib/index.js').then(m=>console.log(m.name, m.inject))"` 打印 `@dsh-external/dsh-web-service ( 'webServer', 'tools' )`（能正常 ESM 加载，无 module 解析报错）。

---

## 3) 启动命令

**没有 `start`/`dev` 脚本**。"启动" = 让 DSH 宿主加载这个 Cordis 插件，使其路由挂到宿主 webserver。两条路径：

### 3a. 标准方式：挂载进 DSH profile + 重启 DSH（推荐、持久化）

```bash
# 前提：DSH 已有一个在跑的 profile（本机 web GUI 默认 profile 为 web，监听 3080）。
# 把插件 link 进 profile 的 package.json + bundles，bundle patch 自动把插件行 insert 进装配层。
dsh plugin --profile web add /Users/tsbj/feyanggit/DHS-test/dsh-web-service
# 然后重启 DSH（宿主进程）以让新行生效，例如：
#   停掉当前 dsh 进程 → 重新 dsh 启动（按本机 DSH 启动习惯，通常 `dsh` 或 `dsh web`）
```

重启后插件由宿主正常装配，路由挂在主 webserver（默认 3080）的 `/api/v1` 前缀下。

### 3b. 免重启热注入（需本机已装 dsh-super-injector，本环境已装）

```jsonc
// 在 DSH Web GUI 的智能体会话里调用（工具，非 shell 命令）：
dev_install_package {"dir": "/Users/tsbj/feyanggit/DHS-test/dsh-web-service", "profile": "web"}
```

- 行为：改 profile `package.json`（dependencies 加 link + bundles 加包名）→ 建 `node_modules` junction → `loader.create` 动态加载，**免重启即时生效**，重启后仍由 bundles 列表正常装配（双路径一致）。
- 热重载 / 重载前后对比：`dev_reload_package {"packageName": "dsh-web-service"}`。
- 列已装配插件（验证用）：`dev_plugin_status`。

### 运行期配置（可选，写在挂载行的 `config`，均有默认值）

```yaml
- id: dsh-web-service
  name: '@dsh-external/dsh-web-service'
  config:
    pathPrefix: /api/v1        # 路由前缀（默认 /api/v1）
    apiKey: ''                 # 非空则开启三方调用鉴权
    standalonePort: 0          # >0 时额外独立监听该端口（0=仅用主 webserver）
    cors: true
    defaultCwd: ''             # 空=process.cwd()
    maxUploadBytes: 2147483648
```

`standalonePort` 是唯一"独立端口"开关：设 `>0` 会在 `0.0.0.0:<port>` 再起一个独立 HTTP 监听；不设为 0 则全部走宿主 3080。

---

## 4) 环境要求

| 项 | 要求 | 本机现状 |
|---|---|---|
| 操作系统 | macOS（方案针对 macOS） | ✅ 已确认 |
| Node.js | 构建用 `ES2023` + `NodeNext`；运行需能加载 ESM。**建议 ≥ 20**（本机 v26.7.0 满足） | ✅ v26.7.0 |
| TypeScript | 由 checkout 提供 `node_modules/.bin/tsc`（`typescript ^5.9`），**无需单独装** | ✅ 已存在 |
| 包管理器 | 无约定（无 lockfile）；构建不依赖它 | pnpm 11.7.0 可用（非必需） |
| DSH checkout | **硬依赖**：须含 `packages/`、`vendor/`、`node_modules/.bin/tsc`，自动探测或 `export DSH_CHECKOUT=...` | ✅ `/Users/tsbj/feyanggit/deepseek-harness` 命中 |
| DSH 宿主进程 | 运行期需要一个在跑的 DSH（含 webserver，默认 3080）作为宿主 | 本机 web GUI 在 3080 |
| 端口 | 主 webserver **3080**（默认，`/api/v1`）；可选 `standalonePort`（`>0` 时额外监听，绑 `0.0.0.0`） | — |
| 环境变量 | `DSH_CHECKOUT`（可选，指向 DSH 源码 checkout）；运行期无强制 env | 本机可自动探测，可不设 |
| 鉴权 | `config.apiKey` 非空时三方请求需带 key（本地自测留空即可） | 默认空 |

---

## 5) 端到端步骤总览 + 每步验收标准

> 顺序执行；每步给出"通过判据"。全程不实际执行，仅为规划。

### Step 0 — 前置探测（已做，复核即可）
- 命令：`ls -d $DSH_CHECKOUT/packages && node --version && ls node_modules/.bin/tsc`（checkout 内）。
- 通过判据：`packages/` 存在；node ≥ 20；checkout 的 `tsc` 可执行。

### Step 1 — 依赖准备
- 命令：**无**（不需 `npm/pnpm install`）。可选 `export DSH_CHECKOUT=/Users/tsbj/feyanggit/deepseek-harness`。
- 通过判据：`node_modules/` 下 `cordis`、`schemastery`、`@deepseek-ai/*` 为指向 checkout 的 symlink。

### Step 2 — 构建
- 命令：`cd /Users/tsbj/feyanggit/DHS-test/dsh-web-service && bash scripts/build.sh`
- 通过判据：
  - 打印 `=== Build complete ===`，exit 0；
  - `lib/index.js` 等重新生成（时间戳更新）；
  - `node -e "import('.../lib/index.js').then(m=>console.log(m.name,m.inject))"` 打印 `@dsh-external/dsh-web-service ['webServer','tools']`。

### Step 3 — 类型检查（可选）
- 命令：`npx tsc -p tsconfig.json --noEmit`
- 通过判据：无类型错误，exit 0。

### Step 4 — 启动 / 挂载
- 标准：`dsh plugin --profile web add /Users/tsbj/feyanggit/DHS-test/dsh-web-service` → 重启 DSH。
- 或热注入：`dev_install_package {"dir":".../dsh-web-service","profile":"web"}`。
- 通过判据：
  - `dev_plugin_status`（或宿主装配日志）出现 `@dsh-external/dsh-web-service` 且 fiber 正常；
  - 启动日志**无** `Cannot find package '@dsh-external/dsh-web-service'`、无 `invalid config`、无路由注册报错。

### Step 5 — 探活与功能验收
- 命令：
  ```bash
  curl -s http://127.0.0.1:3080/api/v1/system/status
  curl -sI http://127.0.0.1:3080/api/v1/docs | head -1
  curl -s http://127.0.0.1:3080/api/v1/openapi.json | head -c 100
  ```
- 通过判据：
  - `system/status` 返回 `{"ok":true, data:{ name:'@dsh-external/dsh-web-service', status:'running', port:3080, prefix:'/api/v1', ... }}`；
  - `/docs` 返回 `HTTP/1.1 200 OK`；
  - `openapi.json` 开头为 `{` 的合法 JSON（含 `openapi: "3.0"`）；
  - 抽测一个业务路由，如 `curl -s http://127.0.0.1:3080/api/v1/workspaces` 返回 `{ok:true, data:[...]}`（列表可为空）。

### Step 6 —（可选）独立端口验收
- 若把 `config.standalonePort` 设为 `>0`（如 3901）重启：
  - 通过判据：`curl -s http://127.0.0.1:3901/api/v1/system/status` 同样返回 `ok:true`，`data.standalonePort=3901`。

---

## 附：机器可读方案（JSON）

```json
{
  "project": "@dsh-external/dsh-web-service",
  "kind": "dsh-cordis-host-plugin",
  "note": "非独立 Web 进程；注入宿主 webServer/tools 并把路由挂到宿主 webserver(默认3080)的 /api/v1 前缀。无 start/dev 脚本，'启动' = 挂载进 DSH profile 并重启，或 dsh-super-injector 热注入。",
  "absPath": "/Users/tsbj/feyanggit/DHS-test/dsh-web-service",
  "packageManager": {
    "lockfile": "none",
    "needsInstall": false,
    "reason": "peer 依赖(cordis/schemastery/@deepseek-ai/*)全部来自 DSH checkout，build.sh 自动 symlink；无 lockfile 故无 pnpm/npm 约定差异。",
    "installCommands": []
  },
  "build": {
    "command": "cd /Users/tsbj/feyanggit/DHS-test/dsh-web-service && bash scripts/build.sh",
    "optionalTypecheck": "cd /Users/tsbj/feyanggit/DHS-test/dsh-web-service && npx tsc -p tsconfig.json --noEmit",
    "accept": [
      "输出 '=== Build complete ===' 且 exit 0",
      "lib/index.js 等重新生成（时间戳更新）",
      "node -e \"import('.../lib/index.js').then(m=>console.log(m.name,m.inject))\" 打印 @dsh-external/dsh-web-service ['webServer','tools']"
    ]
  },
  "start": {
    "standard": {
      "command": "dsh plugin --profile web add /Users/tsbj/feyanggit/DHS-test/dsh-web-service",
      "then": "重启 DSH 宿主进程",
      "persist": true
    },
    "hotInject": {
      "tool": "dev_install_package",
      "args": { "dir": "/Users/tsbj/feyanggit/DHS-test/dsh-web-service", "profile": "web" },
      "persist": true,
      "reload": { "tool": "dev_reload_package", "args": { "packageName": "dsh-web-service" } },
      "list": { "tool": "dev_plugin_status" }
    }
  },
  "env": {
    "os": "macOS",
    "node": ">=20 (本机 v26.7.0)",
    "typescript": "由 DSH checkout 提供 node_modules/.bin/tsc (types ^5.9)，无需单独安装",
    "checkout": {
      "required": true,
      "autoProbeHit": "/Users/tsbj/feyanggit/deepseek-harness",
      "envVar": "DSH_CHECKOUT"
    },
    "port": {
      "main": 3080,
      "prefix": "/api/v1",
      "standalonePort": "0=仅主 webserver；>0 额外独立监听 0.0.0.0:<port>"
    },
    "configKeys": {
      "pathPrefix": "/api/v1",
      "apiKey": "",
      "standalonePort": 0,
      "cors": true,
      "defaultCwd": "",
      "maxUploadBytes": 2147483648
    }
  },
  "acceptance": {
    "pluginMounted": "dev_plugin_status 出现 @dsh-external/dsh-web-service 且 fiber 正常；启动日志无 'Cannot find package' / 'invalid config' / 路由注册报错",
    "probe": [
      "curl -s http://127.0.0.1:3080/api/v1/system/status -> {\"ok\":true, data:{name:'@dsh-external/dsh-web-service',status:'running',port:3080,prefix:'/api/v1'}}",
      "curl -sI http://127.0.0.1:3080/api/v1/docs | head -1 -> HTTP/1.1 200 OK",
      "curl -s http://127.0.0.1:3080/api/v1/openapi.json | head -c 100 -> 合法 JSON，openapi:3.0"
    ],
    "sampleBusinessRoute": "curl -s http://127.0.0.1:3080/api/v1/workspaces -> {\"ok\":true, data:[...]}"
  },
  "cleanupOptional": {
    "staleArtifacts": "lib/ 含历史 .bak-* 文件(streaming.ts.bak-*)，构建不受影响，可手动清理"
  }
}
```
