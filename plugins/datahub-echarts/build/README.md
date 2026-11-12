# 客户端构建与验证

`../client.js` 是已构建产物，由 Harness 的 `window.__ModuleLoader__` 加载。`react` 使用宿主模块，ECharts 6.1.x、zrender 与官方 SheetJS CE 0.20.3 内联到产物，运行时无需用户安装。SheetJS CE 按 Apache-2.0 分发，随插件保留 `../LICENSE-SHEETJS`。

## 源码

- `client-entry.js`：同轮结果区、多表标签、各结果独立的视图选择、真实 Canvas 绘图、表格、导出菜单与结果区边框外的一组“进一步分析”；来源信息仅保留内部校验。
- `event-projection.js`：同时投影 `query_result_chart`、`datahub_chart` 的成功结果，处理回放去重与结果替换。
- `rebuild.mjs`：esbuild 打包为 CJS，注入插件版本并包装为 Harness 客户端模块；第三个参数 `xlsxDir` 指向官方 SheetJS CE 0.20.3 包目录。
- `export.test.js`：通过 `XLSX_DIR` 和 `ESBUILD_DIR` 加载构建依赖并验证 CSV/XLSX 导出。

## 构建与回归

使用 Node 22+、esbuild 0.25.x、ECharts 6.1.x 与官方 SheetJS CE 0.20.3。构建依赖放在独立开发目录，无需安装到 DSH profile。以下命令从插件目录执行，`xlsxDir` 为官方 SheetJS CE 0.20.3 包目录。

```powershell
$env:ESBUILD_DIR = "<esbuild目录>"
$env:XLSX_DIR = "<SheetJS CE 0.20.3目录>"
node --test core.test.js results.test.js build/event-projection.test.js build/export.test.js
node build/rebuild.mjs <esbuild目录> <echarts目录> <xlsxDir>
node --check client.js
node build/smoke.mjs
```

单元回归覆盖来源绑定、自动来源、多来源歧义、模型可见调用 ID、DataHub 来源一致性、列选择、数值与标识列、错误/替换结果，以及 CSV 的 BOM、公式前缀文字保护和 XLSX 原始文本/数值类型。桩烟测检查产物加载、注册、渲染与跟问插入。

0.10.0 的行为约定是：普通业务问数拿到最终成功行列结果后，由模型调用 `query_result_chart`，默认表格；明确要求绘图时显示相应图形，视图下拉支持表格、柱状图、折线图、饼图。同轮查询结果集中在一个结果区，多表通过标签切换，单表不显示标签，每个结果各自保留视图选择。导出菜单提供 CSV/XLSX，均导出当前选中结果已加载真实数据的全部列，图形视图同样导出数据而非图片；分页或截断时备注说明已加载范围，不自动查询其他页。XLSX 设置表头和列宽。整轮最多显示一组三条“进一步分析”，位于结果区边框外；中间调用可省略 `followUps`，最后一次调用提供面向本轮全部结果的整体建议。结果区不显示插件版本脚注，来源信息仅用于内部校验。插件展示成功后，模型正文只补充结论、口径与建议，不重复输出 Markdown 表格；这是模型输出指引，不表示插件会自动去除历史正文中的表格。插件不自动监听查询工具。元数据准备操作不触发结果区，已有结果直接复用，用户明确只要文字时不调用展示工具。安装后的在线验收需同时核对这些模型调用行为。

## 真实桌面浏览器验证

准备独立的 `playwright-core`，本机 Chrome（或 Playwright 已下载的 Chromium），以及固定版本 React/ReactDOM 18.3.1 官方 UMD 测试脚本。

```powershell
node build/browser-smoke.mjs --playwright-dir <playwright-core目录> --react-script <react-18.3.1.production.min.js> --react-dom-script <react-dom-18.3.1.production.min.js> --xlsx-dir <SheetJS CE 0.20.3目录> --out-dir <测试输出目录>
```

不启动服务器。脚本真实挂载 React 与构建产物，验证 Canvas、同轮多表标签与单表无标签、各结果独立保留视图、视图下拉中的四种视图、原始表值、导出当前选中结果、结果区边框外至多一组三条“进一步分析”与回退边界，确认来源界面和插件版本脚注不展示。`--xlsx-dir` 指向官方 SheetJS CE 0.20.3 包目录，用于读回实际下载的 XLSX，校验全部列、原始文本/数值类型和导出范围，同时验证 CSV 下载内容。脚本输出报告、可独立打开的夹具和桌面截图。浏览器夹具验证不能替代安装后在既有 DSH GUI 的在线验收。

## 本地更新与发布

1. 递增插件版本，跑回归、重建、桩烟测和浏览器测试。
2. 通过官方 `plugin_manager` 升级。已安装同名包时，记录旧来源、状态和备份，再移除、安装，失败时从旧来源恢复；不手改 profile 的依赖或补丁。
3. 若管理工具在当前会话不可用，已获代码编辑授权时可备份并更新**原本链接到的普通工作区源码目录**，保留 profile 链接。Host 没有监视源码时必须重启既有 DSH，不能仅凭客户端界面冒称 Host 新工具已加载。
4. 在现有 GUI 刷新后，通过插件管理器核对安装版本为 `0.10.0`，并确认新工具可见、结果区不显示版本脚注。仅槽位注册或客户端更新不能证明完整升级。

插件版本与 DataHub 应用版本独立。未经用户要求，不推送源代码、修改数据库或部署 DataHub 服务。
