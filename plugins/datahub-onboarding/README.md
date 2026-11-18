# DataHub 一键接入（`@local/datahub-onboarding`）

在善治 DSH 设置页输入 DataHub 空间 API Key，点击“验证并连接”，即可接入 `datahub-ask-data` 与 `datahub-knowledge` 两个 MCP。用户不需要运行安装脚本、执行 PowerShell、手工编辑 YAML，或把 Key 写进插件配置。

本插件只使用原生 DSH 能力：`ctx.credentials` 的 CredentialRef、`probeServer`、`ctx.mcpManager.register()`、`ctx.skills.registerProvider()` 和 `settings.section`。不修改 Harness、安装脚本、代理或其他插件。

## 使用前提

1. 已登录善治账号。
2. 账号插件提供以下接口；本插件不会从旧 token、旧 MCP URL、Alpha 或 `browserOrigin` 猜测地址：
   - `ctx.get('deepseekAccount').getXiaozhiEnvironment()` 返回 `{ origin?: string }`；
   - `xiaozhi-account/environment-changed` 事件携带 `origin: string | undefined`。
3. DSH 宿主版本与 `package.json` 中的 peer 版本匹配，并已挂载 MCP、凭据、Skill、Settings 和设置页服务。

打开“设置 → DataHub 数据服务”，查看只读服务器地址，输入空间 API Key，然后点击“验证并连接”。页面提供中英文文案、两个服务的独立状态、重新检测、断开连接和清除 Key。已保存 Key 只显示“已保存”，不会回显。

## MCP 参数

| 服务 | URL | 工具调用超时 |
| --- | --- | ---: |
| `datahub-ask-data` | `${origin}/api/mcp/ask-data` | 180000 ms |
| `datahub-knowledge` | `${origin}/api/mcp/knowledge` | 120000 ms |

两个注册条目的请求头均为：

```js
{ 'X-API-Key': '${credential:XIAOZHI_DATAHUB_API_KEY}' }
```

MCP 注册通过 `ctx.mcpManager.register(name, entry)` 完成。验证阶段直接复用原生一次性 `probeServer`，使用 mcp-client 配置、`expandTemplates: true` 和暂存引用，不为探测注册工具或占用正式服务名。

## 凭据与连接生命周期

### 两阶段提交

1. 新 Key 写入 `XIAOZHI_DATAHUB_API_KEY_STAGING`。
2. 使用暂存引用依次探测两个端点；旧正式 Key 和旧连接保持不动。
3. 两端点均成功且探测清理完成后，才写入 `XIAOZHI_DATAHUB_API_KEY`。
4. 保存非敏感的 `boundOrigin`，再补齐本插件的 MCP 注册。
5. `finally` 清除暂存引用。

正式提交后若保存绑定或注册失败，插件会尽力恢复原正式 Key 和原 `boundOrigin`，并只撤销本次新增的注册。连接、换 Key、重试、断开和清理均串行执行；RPC AbortSignal、页面取消按钮和插件卸载都可取消当前操作。

RPC 状态只暴露 `configured: boolean`、origin/绑定地址、服务状态、探测阶段和固定错误码。不返回 Key、凭据来源、请求头、原生错误正文或原生 `lastError`。日志也只记录固定错误码。

### 启动恢复与环境变化

- 已保存 `boundOrigin` 与当前显式 origin 相同、正式 Key 存在且不存在旧配置时，启动后恢复两个注册。
- origin 不同或正式 Key 不存在时不注册。
- 环境变化事件会立即中止当前操作并释放本插件注册，然后串行完成清理。旧 Key 不会自动发往新 origin；必须在新页面输入并验证 Key。
- “重新检测”只会在当前 origin 与 `boundOrigin` 相同且正式 Key 存在时使用正式引用探测。
- “断开连接”释放注册并清除 `boundOrigin`，保留正式 Key，避免下次启动未经操作自动恢复。
- “清除 Key”还会移除正式引用和暂存引用。

### 旧安装脚本兼容

只读检查 `configEditor.entries()` 中的条目 id：

- `mcp-datahub-ask-data`
- `mcp-datahub-knowledge`

任一条目存在即进入 `legacy-managed`：设置页只读，不注册同名 MCP，不读取旧 Key，不删除、修改或迁移旧条目。本版本不提供自动迁移。

## 设置与 RPC

Cordis 条目的配置只有一个非秘密字段：

| 字段 | 含义 |
| --- | --- |
| `boundOrigin` | 验证成功时绑定的显式 HTTP(S) origin；通过原生 Settings 持久化 |

Key 不在此配置中。插件不直接解析或改写 YAML；`boundOrigin` 的持久化由宿主原生 Settings 实现负责。

Host Remote 服务名为 `datahubOnboarding`：

| 方法 | 请求 | 作用 |
| --- | --- | --- |
| `state` | `{}` | 获取安全状态快照 |
| `connect` | `{ apiKey, origin }` | 串行验证并连接；Host 核对预期 origin |
| `retry` | `{ origin }` | 使用已保存正式 Key 重新检测同一绑定 |
| `disconnect` | `{}` | 释放注册并清除绑定，保留 Key |
| `cancel` | `{}` | 取消当前操作 |
| `clearKey` | `{}` | 断开并清除正式/暂存 Key 与绑定 |

## 内置 Skill

`assets/skills/` 随包包含：

- `datahub-ask-data/SKILL.md`
- `datahub-knowledge/SKILL.md`

二者由只读的 `datahub-onboarding` SkillProvider 提供，`source: 'bundled'`，使用原生内置 Skill 优先级。插件不写用户 Skill 目录，也不覆盖同名用户 Skill；最终选择交给原生 SkillRegistry。

## 开发、测试与构建

纯 ESM JavaScript，设置页使用 `React.createElement`，无需 JSX 转译。`client.js` 是随包分发的浏览器构建产物；可维护源码在 `build/client-entry.js`。

运行测试：

```sh
npm test
```

测试基于 `node:test` 与内存假实现，不访问真实 DataHub、不启动服务器，也不读取真实凭据。覆盖 origin 派生、空 origin、legacy 只读、启动恢复、暂存失败保留旧连接、环境变化释放、成功注册参数、串行换 Key、失败回滚、状态不泄密、断开/清除及 Skill 加载。

客户端源码变更后，用本机已有 esbuild 包重建：

```sh
node build/rebuild.mjs "<esbuild 包目录>"
```

该命令只重建本插件的 `client.js`，不启动开发服务器。

## 联调边界

单元测试不能替代真实宿主验收。安装后仍需与账号插件联调：初始 origin、环境变化事件、真实 CredentialRef 持久化、两个真实 MCP 的握手/工具发现、设置页 RPC 和旧配置冲突。代理与网络策略仍由原生 MCP/宿主负责，本插件不修改 `model-proxy`。
