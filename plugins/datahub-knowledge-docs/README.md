# 问知文档（datahub-knowledge-docs）

DeepSeek Harness 问知结果展示插件，包名 `@local/datahub-knowledge-docs`，版本 **0.3.1**。配合 DataHub 知识库 MCP，在会话中展示真实文档、检索证据，并通过右侧文件预览打开原文。

## 功能

- **找文档**：使用 `purpose: "documents"`，展示最终确认匹配的“找到的文档”及原文入口，不展示知识证据片段，也不要求模型生成长摘要。
- **问知识**：使用 `purpose: "knowledge"`，模型依据真实证据回答，在本轮末尾集中展示“检索来源”；各文档的检索片段可展开。
- 文档按知识库分组，默认展示前 5 份，可展开其余文档。同名但属于不同知识库的文件保留独立身份。
- 点击“查看原文”后，由宿主读取授权检索地址、缓存文件并交给右侧预览；插件处理原文获取，具体文件类型的呈现能力由宿主文件预览决定。
- 使用服务返回的原文地址与有效期，失效或无原文时显示对应状态，不从文件名猜测地址，不自动重新检索。
- 从保存的会话事件重建结果；不把失败或已截短的检索当作成功的完整文档列表。

## 前提与安装

需要已授权的 `mcp__datahub-knowledge__retrieve_knowledge`，其结构化返回须包含 `schemaVersion: 2` 及文档、证据信息。旧接口未提供展示数据时插件会提示不支持，不能据此宣称已生成卡片。

本版本使用的 DSH peer API 声明为 `>=0.2.0-0`，客户端依赖会话与右侧栏服务。是否适用于其他宿主版本，需要实际安装验证。

通过插件目录或官方插件管理器安装本仓库的 `plugins/datahub-knowledge-docs`，不要安装仓库根目录。目录链接安装必须保留源码目录；也可在本目录执行 `npm pack --ignore-scripts` 后，通过 `dsh plugin --profile desktop add "<安装包绝对路径.tgz>"` 安装独立包。核对包名、版本、来源和运行状态；宿主要求重启或仍引用旧目录时，完整退出桌面端后重开。

源码及通用安装说明见 [仓库 README](../../README.md)。本插件不包含知识库凭据，也不提供文档入库或索引管理能力。

## 展示流程

1. 模型调用问知 MCP，按用户意图传入 `purpose`。
2. 检索成功后调用 `knowledge_documents_present`，确认最终展示场景和真实文档。
3. 省略 `documentRefs` 时，仅分页读取候选索引，每页 20 份；使用返回的 `cursor` 继续。读取候选索引不等于提交展示。
4. 传入真实 `documentRefs` 数组后提交最终选择；空数组表示没有确认匹配文件。问知识时可额外指定真实 `evidenceIds` 限定证据范围。

例如，在已成功检索的当前回合中：

```json
{
  "purpose": "documents",
  "documentRefs": ["<检索结果返回的真实 documentRef>"]
}
```

工具不执行检索，不接受模型自填文件名、链接或正文。找指定文件须核对完整文件名或准确主名，不把全部召回候选直接当作命中文件；`documentLimit` 是候选上限，不等于总命中数。工具失败应报告失败，不能表述成“没有找到”。

## 开发与验证

- `index.js`：使用指引、展示工具与宿主服务注册。
- `results.js`、`host-bridge.js`、`event-projection.js`：结果校验、最终选择、会话记录与回放。
- `original-preview.js`：原文地址校验、授权、下载和缓存。
- `build/client-entry.js`、`client.js`：客户端源码与构建产物。

在插件目录运行现有测试：

```powershell
node --test results.test.js event-projection.test.js host-bridge.test.js original-preview.test.js
```

客户端构建入口为 `build/rebuild.mjs`，浏览器验证入口为 `build/browser-smoke.mjs`，所需参数见脚本开头。单元及夹具测试不能替代在目标 DSH 中执行真实检索、选择和原文预览的验收。

## 许可证

本插件按 [MIT License](LICENSE) 分发。
