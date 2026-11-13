# 子技能：本地文件上传到远程节点（跨节点文件落地）

把**本地机器上的文件**放到**远程 DSH 节点的指定路径**——装技能、铺插件、落配置、跨节点搬运都用这个。

与 `files-resources.md` 的区别：那里讲 `file_manage` 操作 *WorkBuddy 管理的远端工作区*；这里讲*落到节点任意路径*（如 `~/.dsh/skills/`、`~/.dsh/integrations/`），以及绕开各种沙箱与覆盖限制。

## 先选路

| 场景 | 路线 |
|---|---|
| 给远程任务带附件（发任务的一部分） | **路线 C**：任务三步流程，见 `workbuddy-mcp/SKILL.md`「带大文件的任务：标准三步流程」 |
| 把文件落到远程节点指定路径（装技能/铺配置） | **路线 A**（能直连 web-service 时首选）或 **路线 B** |
| 文件 > 10MB 且要落节点路径 | **路线 D**：P2P 分片直传 |
| 节点不暴露 web-service | 路线 B（让节点上的 agent 自己下载）或 `ssh_resource_manage` 的 `exec` |

> 铁律：**文件不传进任务 message**。`create` 带 message = 任务立刻开跑，附件还没传完就开跑，历史上造成过 206MB 白传（task-80e9bfbd）。

## 路线 A · DSH web-service 直传（首选）

节点上的 DSH 把 `dsh-web-service` 暴露成 HTTP API，路径前缀 `/api/v1`，经 ONENAT 隧道可达。

### 0. 拿到 baseUrl 与鉴权

```bash
workbuddy_resource_manage {"action":"resolve","mappingId":"<mappingId>"}
# → endpoint.baseUrl，例如 http://natpass.yikaihui.com:34192/api/v1
```

先探一次鉴权与技能根目录（`GET /skills` 回包里的 `root.path` 就是节点的真实技能目录）：

```bash
curl -s "$BASE/skills" | head -c 300
```

- 回 `{"ok":true,...}` → 节点 `authEnabled:false`，免鉴权，直接用。
- 回 `401 Unauthorized` → 需 `Authorization: Bearer <key>`；key 从节点侧 `~/.dsh/dsh-web-service/api-keys.json` 取（该文件存的是 hash+sealed，明文需另行获取），或问节点 owner 拿。

### 1. 建工作区（会话 cwd = 工作区路径）

```bash
# path 必须是一个已存在的目录
curl -s -X POST "$BASE/workspaces" -H "Content-Type: application/json" \
  -d '{"path":"/Users/panzj/.dsh/skills","title":"node-skills"}'
curl -s -X POST "$BASE/sessions" -H "Content-Type: application/json" \
  -d '{"workspaceId":"<wsId>","title":"upload","provider":"xindu","model":"deepseek-v4.1-flash"}'
# → data.sessionId
```

### 2. 上传（multipart）

```bash
curl -s -X POST "$BASE/sessions/$SID/files" \
  -F "file=@/local/path/file.tgz;filename=file.tgz"
```

落盘位置 = **会话工作区根目录**，回包 `files[0].path` 是绝对路径。

### 3. 四个必须知道的限制

| 限制 | 表现 | 绕法 |
|---|---|---|
| **文件名被 sanitize** | `filename` 只取 basename，`a/b/c.txt` → `c.txt`，**不能靠 filename 定位子目录** | 先让 agent `mkdir` 出子目录（见路线 B），再传 |
| **不覆盖同名文件** | 目标已存在时自动改名 `x-1.txt`，**永不覆盖** | 先删（路线 B）或换个名字 |
| **bash 沙箱按工作区隔离** | 工作区**外**的 `mkdir/cp/rm/mv` 一律 `Operation not permitted` | 把工作区设成**目标的父目录**（见路线 B 第 2 步） |
| **只能读工作区内** | `GET /sessions/$SID/files?path=` 用 `safeJoin` 限制在 cwd 内 | 同上 |

## 路线 B · 让远程 agent 落地（写工作区外 / 精确改配置）

需要把文件写到工作区**之外**（如 `~/.dsh/integrations/`），或要精确修改既有配置文件时走这条。

### 核心原则：内容不让模型转写

让 agent 逐字重写一段 YAML/脚本必然出错。**先上传字节，再让 agent 执行一条短命令**：

```bash
# ① 先用路线 A 把内容精确上传到工作区
curl -s -X POST "$BASE/sessions/$SID/files" -F "file=@/local/patch.yml;filename=patch.yml"

# ② 再让远程 agent 执行这一条（幂等、可重复跑）
P=/path/to/target/file.yml; F=/path/to/workdir/patch.yml
grep -q mcp-android-emulator "$P" || cat "$F" >> "$P"
```

> 追加用 `grep -q … || cat … >>` 而不是无条件 `>>`：重跑不会写出重复条目。
> **改既有文件用 `sed -i ''`（macOS 必须带空串参数）**，别让 agent 重写全文。

### 让 agent 执行 bash

```bash
curl -s -N -X POST "$BASE/sessions/$SID/prompt-stream" \
  -H "Content-Type: application/json" -d '{"prompt":"执行下面这一条 bash 命令，把完整输出（含 stderr）原样贴给我：\n<一条命令>"}'
```

返回 SSE（`event: delta` / `reasoning` / `tool_call` / `done`）。prompt 里**只给一条命令**，并要求贴原始输出——多条命令会让 agent 自由发挥。

### 解除沙箱：工作区设为目标的父目录

agent 的 bash 写操作被限制在会话工作区内。要写 `~/.dsh/integrations/`，就把工作区建成 `~/.dsh`：

```bash
curl -s -X POST "$BASE/workspaces" -H "Content-Type: application/json" \
  -d '{"path":"/Users/panzj/.dsh","title":"dsh-home"}'
```

目标在 `~/.dsh` 之下 → 落在工作区内 → `cp`/`rm`/`mkdir` 全部放行。实测：`cp`/`rm` 到 `~/.dsh/skills/**` 在工作区为 `~/.dsh/profiles/desktop` 时报 `Operation not permitted`，换工作区后成功。

### 移动文件用 cp + rm，不要用 mv

macOS 上 `mv` 会被 `Operation not permitted` 拒绝，但 `cp` + `rm` 可行：

```bash
cp "$SRC" "$DST" && rm -f "$SRC"
```

### 别把运行时文件放在技能目录里

DSH 的技能安装接口（`POST /skills`）重装同名技能时会 `rm -rf` 整个技能目录再重建——放进去的 `server.js` 之类会**被删掉**，指向它的 MCP 注册随之失效。运行时文件放 `~/.dsh/integrations/<name>/`，技能目录只放 `SKILL.md` 与 `references/`、`assets/`。

## 路线 C · 任务带附件（三步流程）

给任务带文件时用 `workbuddy-mcp` 的 putfile 流程（完整版见 `workbuddy-mcp/SKILL.md`）：

1. `workbuddy_task_manage {"action":"create","projectId":...,"title":...}` —— **不带 message**，任务保持 draft 不执行
2. `bash <技能目录>/workbuddy-mcp/scripts/wbmcp.sh putfile /local/file.zip task-xxxx` —— P2P 直传 4MB/片，不经服务器中转
3. `workbuddy_task_manage {"action":"send","taskId":"task-xxxx","message":"日志已上传到 <路径>，请分析…"}` —— 此时任务才开始执行

`putfile` 会回显落盘路径与跨节点下载 URL；其它节点的成员要用该文件，把「下载 URL + 节点 apiKey」写进 send 的 message。

## 路线 D · 大文件 P2P 直传（≤2GB）

`upload_resumable_init` 只下发**节点直连配方**（节点 API 地址 + apiKey + 分片端点模板），文件字节不经 workbuddy 中转：

1. `workbuddy_file_manage {"action":"upload_resumable_init", ...}` → 拿直连配方
2. 直连节点：`POST` 节点 init → `PUT` 分片（4MB/片，409 表示已收到该片，对账续传）→ `POST` 节点 complete → 得落盘路径
3. `workbuddy_file_manage {"action":"upload_register", ...}` → 登记附件，拿跨节点下载 URL

配方里的 `baseUrlIntranet` 有歧义（每台节点的本机端都是 `127.0.0.1`），**判定是否同机不靠猜**：`GET <基址>/api/v1/ping` 比对返回的 `macs` 与本机网卡 MAC 有交集即本机节点。

## 验证纪律（吃过亏）

1. **agent 的自述不是结论**。实测：agent 报「MCP server 返回 22 个工具」，独立复核是 23 个。一律自己回读：列目录、grep 计数、下载比对。
2. **改完配置要验证引用真实存在**。实测：改了 patch 里的路径但文件实际没落地，配置指向不存在的文件，MCP 静默失效。改完立刻 `ls -l <新路径>`。
3. **上传后回读校验**：用 `GET /sessions/$SID/files?path=` 列目录确认文件名与大小，别只信上传接口的 200。
4. **DSH 的 profile patch 是启动期加载**：改完必须重启 DSH 才生效，重启前工具不会出现——别误判成注册失败。
5. **技能改完确认可被发现**：`GET /skills` 看 `count` 与清单。

## 红线

- 不替用户删数据、清库、重置节点；写操作只碰任务/安装所需的具体路径。
- 不替用户重启宿主进程（远程重启会杀掉正在跑 agent 的宿主，且可能中断会话）。
- 不把凭证（APIKEY、节点 apiKey）写进任务 message 或日志；凭证模式用 `self-fetch` 让远端自取。
- `ssh_resource_manage` 的 `exec` 是危险操作：先确认目标主机与路径，凭证不进无关输出。
