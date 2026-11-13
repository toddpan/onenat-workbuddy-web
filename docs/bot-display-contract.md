# BOT 展示配置与只读档案契约（task-92）

BOT 即现有 `SubAgent`，展示配置随子智能体持久化。`display` 是独立的展示副本，管理者自行填写的介绍与建议，其可信度不能作为能力证明；不代表已安装、已验证或实际可执行的技能，也不改变执行提示词、模型、权限、资源或任务派发规则。

## 写入与字段规范

复用 `POST /onenat-workbuddy/api/agents` 的创建和更新流程，新增可选字段：

```ts
display?: {
  expertise?: string
  welcomeMessage?: string
  quickActions?: { label: string; text: string }[]
}
```

更新时带现有 `id`，其余字段沿用已有管理接口约定。创建归属当前登录用户；修改仅允许子智能体归属人（owner）或平台 admin。无 `ownerUserId` 的 legacy 数据仅 admin 可改；项目共享成员可读展示资料，但项目成员身份不授予子智能体管理权限。无权限写入返回 403。

字符串先 `trim()` 再验证长度，按 Unicode code points 计数（例如 `😀` 算 1，`e` 加组合重音算 2），不按 UTF-16 code units 或可见字形数量计数，不额外做 Unicode normalization。

| 字段 | trim 后允许长度 / 数量 | 空值与更新语义 |
| --- | --- | --- |
| `expertise` | 0..1000 code points | 空字符串清除配置，读时回退 description |
| `welcomeMessage` | 0..500 code points | 空字符串清除配置，读时回退默认欢迎语 |
| `quickActions` | 0..3 项 | 整组替换，`[]` 清空；数组序就是展示序 |
| `quickActions[].label` | 1..40 code points | 必填字符串，trim 后不能为空 |
| `quickActions[].text` | 1..2000 code points | 必填字符串，trim 后不能为空 |

`display` 内仅允许上述三个字段；每个 action 内仅允许 `label`、`text`。拒绝未知字段、错误类型、缺失 action 字段、空 label/text、长度或数量超限，HTTP 400；失败不得部分写入。字段不接受 null，唯一的 null 清除语义是整个 `display: null`。

| 请求内容 | 结果 |
| --- | --- |
| 省略 `display` | 保留全部已有展示配置，兼容旧客户端 |
| `display: null` | 清除整个展示配置，读时使用回退值 |
| `display: {}` | 保留已有展示配置 |
| `display: { welcomeMessage: " 新欢迎语 " }` | 仅更新欢迎语为 `新欢迎语`，保留专长与动作 |
| `display: { expertise: "  " }` | 清除专长配置，其余字段保留 |
| `display: { quickActions: [{ label: "继续", text: "请继续分析" }] }` | 以该单项替换动作组 |

示例（已有资源的字段 patch）：

```http
POST /onenat-workbuddy/api/agents
Content-Type: application/json
Cookie: wb_session=...

{
  "id": "agent-example",
  "display": {
    "expertise": "协助整理项目需求",
    "welcomeMessage": "你好，请描述希望推进的需求。",
    "quickActions": [
      { "label": "整理需求", "text": "请帮我整理当前需求与验收标准。" },
      { "label": "风险检查", "text": "请检查当前方案的风险。" }
    ]
  }
}
```

## 只读展示 API

两个接口都要求现有登录身份，复用 `canViewAgent` 可见性判定：

- `GET /onenat-workbuddy/api/agents/profiles`：成功响应 `{ "ok": true, "data": [profile, ...] }`，不可见条目从数组隐藏。
- `GET /onenat-workbuddy/api/agents/:id/profile`：成功响应 `{ "ok": true, "data": profile }`，不存在或不可见均返回 404。

每个 profile 的固定投影如下，owner、admin 和项目共享成员得到相同字段集合：

```json
{
  "id": "agent-example",
  "name": "需求助手",
  "description": "整理需求和验收标准",
  "display": {
    "expertise": "协助整理项目需求",
    "welcomeMessage": "你好，请描述希望推进的需求。",
    "quickActions": [
      { "label": "整理需求", "text": "请帮我整理当前需求与验收标准。" }
    ]
  }
}
```

缺省值统一由服务端补全，不要求迁移旧数据：`description` 缺省为 `''`；`expertise` 未配置时依次回退到 description、`''`；`welcomeMessage` 未配置时为 `你好，我是${name}。你想先聊些什么？`；`quickActions` 未配置时为 `[]`。这两个接口只返回固定投影，即使调用者是 owner/admin，也不返回 apiKey、systemPrompt、executionPrompt、dshRef、模型、工作目录、资源、技能、归属或共享配置等私密或执行字段。

## 客户端消费与副作用

客户端将名称、描述、专长、欢迎语、动作标签和文本全部作为纯文本渲染，不解释 HTML、Markdown、脚本或嵌入指令。介绍区应表明内容为管理者声明，避免把它标注为已验证技能。

用户选择快捷动作时，仅将该 action 的 `text` 填入可编辑输入框；`label` 只是按钮标题。选择不自动发送、不创建任务、不执行远端动作。用户可以修改或放弃文本，只有用户明确提交后，客户端才调用现有任务创建/发送 API；profile 接口只读，本契约不新增选择端点或快捷动作执行 API。读取列表、读取详情和本地选择动作均无消息发送或任务创建副作用。

## HTTP 回归验证

主 agent 完成构建后运行：

```sh
node --check scripts/bot-display-e2e.mjs
node scripts/bot-display-e2e.mjs
# 可覆盖独立端口；默认 18099，与其他 smoke 使用的端口分离
BOT_DISPLAY_E2E_PORT=18199 node scripts/bot-display-e2e.mjs
```

脚本本身不构建：使用现有 `dist/server.js`，在临时数据目录启动独立服务，走管理员登录、邀请激活普通用户、owner 创建/修改及项目成员共享的真实 HTTP 链路。覆盖严格投影与隐私、旧数据回退、旧客户端省略保留、对象 patch、整组替换、清除、顺序、数量/类型/未知字段/空值错误与 Unicode 边界，并核验失败原子性。

持久化采用允许的读盘核验：等待临时 `store.json` 记录规范化后的展示配置，并检查 null 清除确实去除已配置字段，不必重启服务或重建产物。读取与本地选择测试前后比较所有测试身份可见的任务，以及盘上任务内容，确认没有创建任务或改变任务消息；这验证 HTTP 与本地数据选择的副作用边界，不替代浏览器中“点击只填编辑框”的交互测试。端口已被占用时脚本立即失败，避免误连其他 smoke 服务；结束后仅终止自己启动的进程并删除自己创建的临时目录。非零退出码表示失败。
