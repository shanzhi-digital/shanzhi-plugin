# 通用查询结果图表（datahub-echarts）

在 DeepSeek Harness 对话中，把已执行查询工具的真实结果渲染为 ECharts 卡片。支持 DataHub、其他数据库 MCP、API 与已解析成 JSON 行列的 CSV 工具。包名与安装目录保持兼容，版本 **0.10.0**。

SQL 是查询定义，卡片需要执行后返回的实际行列数据。普通业务问数获得最终成功的行列结果后，模型应调用 `query_result_chart`，默认以表格呈现；用户明确要求绘图时才默认显示对应图形。该入口从当前会话日志读取结果，不执行 SQL，也不接收模型自填数据；原 `datahub_chart` 继续提供 DataHub 查询并展示结果的兼容入口。

这是模型根据工具说明发起的调用，不是插件自动监听所有查询结果。列数据源、读取表结构等元数据准备操作不触发结果区；已有可用结果时直接复用，不为展示重复查询。用户明确只要文字时，尊重其要求，不调用展示工具。插件展示成功后，模型正文只补充结论、口径与建议，不重复输出 Markdown 表格；这是模型输出指引，不表示插件会自动去除历史正文中的表格。

## 功能

- 同轮查询结果集中在一个结果区；多表通过标签切换，单表不显示标签，每个结果各自保留视图选择。
- 普通问数默认表格，用户明确要求绘图时按其指定的指标与图型呈现；通过视图下拉切换表格、柱状图、折线图、饼图，切换直接使用当前结果的同一份数据，不重复查询。
- 导出菜单提供 CSV 和 XLSX，导出当前选中结果已加载真实数据的全部列，不受绘图选列限制；图形视图同样导出数据，不导出图片。分页或截断结果仅导出已加载部分，结果备注说明导出范围，不会自动查询其他页。
- CSV 使用 UTF-8 BOM，并对可能触发电子表格公式的前缀文字做保护；XLSX 保留原始文本和数值类型，设置表头与列宽。
- 只有比较多个指标才画多列；编号、学号、证件号及 `userId` 等标识列不会作维度或指标。
- 原始表格保留原值。空结果、文字明细、单一数值或全部不安全数值回退为表格；负数或全零结果不绘制占比。
- 整轮最多显示一组三条基于真实结果的不同“进一步分析”，位于结果区边框外；点选填入输入框，按 Enter 发送，无法插入时尝试复制。中间调用可省略 `followUps`，最后一次调用提供面向本轮全部结果的整体建议。
- 结果区不显示插件版本脚注。
- 来源工具、调用 ID 和 SQL（有 SQL 时）仅用于内部校验，不展示可展开的查询来源界面；分页、截断与总行数按返回信息说明。
- 会话回放时重建卡片，同一工具结果不重复展示；已被后续 surface replacement 替换的来源不能继续用于新卡片。

## 使用

先通过已授权的来源工具完成业务问数，再由模型用最终成功的真实行列结果调用 `query_result_chart`。普通问数使用表格，例如：

```json
{
  "title": "各地区报名人数",
  "dimension": "region",
  "measures": ["enroll"],
  "followUps": [
    "报名人数最多的地区有哪些活动？",
    "报名人数最少的地区有哪些活动？",
    "可以按月份展示这些地区的报名趋势吗？"
  ]
}
```

以上是 `query_result_chart` 的调用示例，“进一步分析”须根据实际查询结果调整；本轮有多个结果时，中间调用可省略 `followUps`，最后一次调用再提供覆盖全部结果的三条整体建议，整轮只展示一组。普通问数省略 `chartType` 即可默认显示表格；该字段只支持 `bar`、`line`、`pie`，用户明确要求柱状图、折线图或饼图时再传入对应值。

- 本轮只有一个可识别的成功表格来源时，省略 `sourceCallId` 即可自动绑定。
- 本轮有多个来源时，工具返回候选工具名和完整调用 ID，再明确传入 `sourceCallId`。兼容模型可见的 OpenAI 调用 ID 与 Harness 内部组合 ID。
- 嵌套 JSON 用 `resultPath`（JSON Pointer，例如 `/result` 或 `/payload/rows`）选择表格。路径只做数据选择，不执行表达式。
- 显式传入的维度或指标无效时会报错。省略时按用户原话与真实列自动识别；无法绘图时保留表格。

支持的来源 JSON：

```json
{"columns":[{"name":"region","type":"String"},{"name":"enroll","type":"Int64"}],"data":[{"region":"东区","enroll":12}]}
```

```json
{"columns":["region","enroll"],"rows":[["东区",12]]}
```

```json
[{"region":"东区","enroll":12}]
```

也支持 `fields + rows`，以及 `data`/`rows` 对象数组。未提供类型时从真实单元格推断，原始单元格不改写。空数组需要保留列定义。单表上限为 1000 行、100 列，超限应先在来源工具分页或汇总。

通用入口读取可重放的会话工具结果，当前支持文本块中的 JSON，不解析 Markdown 表格、任意文本、CSV 原文或远程 URL。若来源只在进程内 `value`/`structuredContent` 中提供数据，却没有把 JSON 写入会话，须让来源工具输出可持久化 JSON。多份表格、嵌套对象单元格或失败结果会报错。

DataHub 来源仍校验 `queryKind`、数据源 ID 与请求 SQL。数据源访问和 SQL 权限由原查询工具负责；本插件不包含连接凭据，也不新增数据库执行器。

## 安装与升级

前提为支持客户端插件的 DeepSeek Harness 桌面端或 Web GUI。DataHub MCP 是可选来源，使用其他查询工具时无需配置 DataHub。

1. 克隆 `https://gitee.com/groundhogtang/shanzhi-dsh-plugin.git` 并长期保留目录。
2. 请 Harness Agent 使用官方插件管理器安装本目录。已安装同名包时，先记录旧来源，再用管理器卸载、安装新版；不要手工编辑 profile 配置。
3. 刷新现有 GUI；桌面端仍未生效时重启应用。通过插件管理器核对安装版本为 `0.10.0`；结果区不显示插件版本脚注。

安装采用目录链接，删除目录会导致插件失效。0.6.0 的历史卡片和 `datahub_chart` 调用继续支持。

## 开发

- `index.js`：注册通用和 DataHub 两个工具，提供使用说明。
- `results.js`：会话来源绑定、JSON 归一化、来源一致性检查。
- `core.js`：请求识别、维度指标与图型选择。
- `build/client-entry.js`、`build/event-projection.js`：客户端卡片与事件投影。
- `client.js`：随包交付的已构建产物，构建时内联 ECharts 和官方 SheetJS CE 0.20.3，运行时无需用户安装。

```powershell
$env:ESBUILD_DIR = "<esbuild目录>"
$env:XLSX_DIR = "<SheetJS CE 0.20.3目录>"
node --test core.test.js results.test.js build/event-projection.test.js build/export.test.js
node build/rebuild.mjs <esbuild目录> <echarts目录> <xlsxDir>
node build/smoke.mjs
```

`rebuild.mjs` 的第三个参数 `xlsxDir` 指向官方 SheetJS CE 0.20.3 包目录；`build/export.test.js` 通过 `XLSX_DIR` 和 `ESBUILD_DIR` 加载开发依赖，覆盖 CSV 与 XLSX 数据导出。

构建与桌面浏览器验证详见 `build/README.md`。发布记录见 `CHANGELOG.md`。

## 许可

本仓库原创代码采用 MIT。ECharts 采用 Apache-2.0（`LICENSE-ECHARTS`、`NOTICE-ECHARTS`），zrender 采用 BSD-3-Clause（`LICENSE-ZRENDER`），官方 SheetJS CE 0.20.3 采用 Apache-2.0（`LICENSE-SHEETJS`），许可文件随包分发。
