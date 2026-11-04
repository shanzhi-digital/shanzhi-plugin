# 客户端构建与验证

`../client.js` 是已构建产物，由 Harness 的 `window.__ModuleLoader__` 加载。`react` 使用宿主模块，ECharts 6.1.x 与 zrender 内联到产物。

## 源码

- `client-entry.js`：卡片、真实 Canvas 绘图、表格、SQL 来源与跟问。
- `event-projection.js`：同时投影 `query_result_chart`、`datahub_chart` 的成功结果，处理回放去重与结果替换。
- `rebuild.mjs`：esbuild 打包为 CJS，注入插件版本并包装为 Harness 客户端模块。

## 构建与回归

使用 Node 22+、esbuild 0.25.x 与 ECharts 6.1.x。构建依赖放在独立开发目录，无需安装到 DSH profile。

```powershell
node --test core.test.js results.test.js build/event-projection.test.js
node build/rebuild.mjs <esbuild目录> <echarts目录>
node --check client.js
node build/smoke.mjs
```

单元回归覆盖来源绑定、自动来源、多来源歧义、模型可见调用 ID、DataHub 来源一致性、列选择、数值与标识列、错误/替换结果。桩烟测检查产物加载、注册、渲染与跟问插入。

## 真实桌面浏览器验证

准备独立的 `playwright-core`，本机 Chrome（或 Playwright 已下载的 Chromium），以及固定版本 React/ReactDOM 18.3.1 官方 UMD 测试脚本。

```powershell
node build/browser-smoke.mjs --playwright-dir <playwright-core目录> --react-script <react-18.3.1.production.min.js> --react-dom-script <react-dom-18.3.1.production.min.js> --out-dir <测试输出目录>
```

不启动服务器。脚本真实挂载 React 与构建产物，验证 Canvas、四种视图、原始表值、SQL 纯文本、三个跟问与回退边界，输出报告、可独立打开的夹具和桌面截图。浏览器夹具验证不能替代安装后在既有 DSH GUI 的在线验收。

## 本地更新与发布

1. 递增插件版本，跑回归、重建、桩烟测和浏览器测试。
2. 通过官方 `plugin_manager` 升级。已安装同名包时，记录旧来源、状态和备份，再移除、安装，失败时从旧来源恢复；不手改 profile 的依赖或补丁。
3. 若管理工具在当前会话不可用，已获代码编辑授权时可备份并更新**原本链接到的普通工作区源码目录**，保留 profile 链接。Host 没有监视源码时必须重启既有 DSH，不能用前端版本号冒称 Host 新工具已加载。
4. 在现有 GUI 刷新后确认卡片 `v0.7.0`，并确认新工具可见。仅槽位注册或客户端更新不能证明完整升级。

插件版本与 DataHub 应用版本独立。未经用户要求，不推送源代码、修改数据库或部署 DataHub 服务。
