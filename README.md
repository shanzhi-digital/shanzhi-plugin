# 善智 Harness 插件集

此仓库维护多个 DeepSeek Harness 插件，每个插件放在 `plugins/<插件名>` 目录下，独立版本、独立安装。

## 插件清单

| 目录 | 名称 | 版本 | 说明 |
|---|---|---|---|
| `plugins/datahub-echarts` | DataHub 问表图表 | 0.6.0 | 问表/问图时用 ECharts 渲染授权 DataHub 数据源的真实查询结果，附跟问建议 |

## 使用

1. 克隆本仓库到本机长期保留的位置。
2. 在 Harness 对话中让 Agent 通过插件管理器安装对应 `plugins/<插件名>` 目录（安装为目录链接，删除目录即失效）。
3. 首次安装或升级后刷新页面；桌面端如未生效请重启应用。
4. 每个插件的数据源访问权限由其使用的 MCP 连接决定，本仓库不含任何凭据，也不要在对话中提供密钥。

## 目录约定

- 每个插件包含：运行文件（`index.js`、`core.js`、`client.js`、`cordis.patch.yml`、locale、icon）、第三方许可文件，以及 `build/` 下的客户端构建源与烟测脚本。
- 新增插件请沿用同一结构，并在本文件的清单中登记名称、版本与说明。

## 许可证

本仓库原创代码按 **MIT License** 开源分发，见仓库根目录 `LICENSE`。

各插件目录中的 `LICENSE-ECHARTS`、`LICENSE-ZRENDER`、`NOTICE-ECHARTS` 仅约束对应的第三方组件（ECharts 为 Apache-2.0，zrender 为 BSD 3-Clause），转载时按其原文保留。

## 维护

- 发布插件新版本时：修改 `package.json` 的 `version` → 跑测试 → 重建客户端产物 → 烟测 → 提交并打版本标签。
- 不要在仓库中保存密钥、会话记录、业务查询数据或个人信息。
