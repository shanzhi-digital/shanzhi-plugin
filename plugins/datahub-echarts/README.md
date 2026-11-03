# DataHub 问表图表（datahub-echarts）

当用户本轮明确要求问表、表格或图表时，执行授权 DataHub 数据源的语义 SQL，在会话回答末尾渲染 ECharts 图表卡片。

## 功能

- 柱状图 / 折线图 / 饼图，卡片右上角可切换「柱状图 | 折线图 | 饼图 | 表格」，默认不展示原始查询结果。
- 维度与指标：优先取调用方显式声明，其次按用户本轮问题的措辞匹配真实列名，最后退回第一个数值列；编号/学号/证件类标识列不会当作指标。
- 纯文字明细、单一统计值、空结果或数值超出安全精度时，不强行出图，保留真实表格并说明原因。
- 图表下方显示 3 条跟问建议（由模型基于本次问题和真实结果生成），点选后写入输入框，按 Enter 发送；无法插入时退化为复制到剪贴板。
- 卡片右下角显示插件版本号，便于确认页面运行的版本。

## 前提

- DeepSeek Harness（桌面端或 Web GUI）。
- 已配置 DataHub 问数 MCP（`datahub-ask-data`），且当前会话对目标数据源有查询权限。本插件只做呈现，不包含任何数据源授权或凭据。

## 安装

整个仓库克隆下来后，用 Harness 插件管理器安装本目录（**安装的是链接，目录不能删**）：

1. `git clone https://gitee.com/groundhogtang/shanzhi-dsh-plugin.git`
2. 在 Harness 对话中请 Agent 安装本地插件目录，例如：
   `请安装本地插件 D:\路径\shanzhi-dsh-plugin\plugins\datahub-echarts`
3. 安装完成后刷新页面（桌面端如未生效请重启应用），再问一句问表验证：卡片右下角应显示 `v0.6.0`。

## 开发

- 入口：`index.js`（Host，注册 `datahub_chart` 工具与提示词）、`core.js`（触发与选列逻辑）、`build/client-entry.js`（客户端源码）、`client.js`（已构建产物，随包分发）。
- 测试：`node --test core.test.js`。
- 重建客户端产物与发布流程见 `build/README.md`；重建需要临时的 esbuild 0.25.x 与 echarts 6.1.x 构建环境，二者不进运行时包。

## 版本

当前版本 **0.6.0**。每次发布递增版本号并重建 `client.js`，卡片右下角可核对。

## 第三方许可

- ECharts：Apache License 2.0（`LICENSE-ECHARTS`、`NOTICE-ECHARTS`）。
- zrender：BSD 3-Clause（`LICENSE-ZRENDER`）。
