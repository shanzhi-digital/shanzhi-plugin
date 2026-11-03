# 客户端产物构建说明

`../client.js` 是已构建产物，浏览器通过 `window.__ModuleLoader__.load({ id: '@local/datahub-echarts', factory(require) { … } })` 加载它。

## 源码

- `client-entry.js`：客户端插件源码（注册 `uiConversation` 事件定义，并在 `conversation.chat.turnTail` 渲染图表卡片）。
- 运行时来自宿主模块表的依赖：`react`（保持 external，不从包内重复打包）。
- `echarts` 与 `zrender` 随产物一起打包，许可证见包根 `LICENSE-ECHARTS`、`LICENSE-ZRENDER`、`NOTICE-ECHARTS`。

## 重建

需要一个临时的 Node 构建环境（esbuild 0.25.x 与 echarts 6.1.x，两者只用于构建，不进运行时包）：

```powershell
node build/rebuild.mjs <esbuild目录> <echarts目录>
node --check client.js
node build/smoke.mjs
```

- `rebuild.mjs` 用 esbuild 把 `client-entry.js` 打成 CommonJS 单文件（`react` external，其余全部内联），再把 `package.json` 的 `version` 注入为 `__PLUGIN_VERSION__`，包进 `__ModuleLoader__` 包装写出 `../client.js`。
- `smoke.mjs` 用桩装载器与桩 React 求值 `client.js`，验证：模块 id、`inject`、事件定义注册、槽位注册、以及一轮数据下的卡片渲染不抛错。

## 发布一个版本

每次发布都递增版本号，卡片右下角会显示它，便于确认页面跑的是哪一版：

1. 改 `package.json` 的 `version`（语义化版本，例如 0.5.0 → 0.5.1 修缺陷、0.6.0 加能力）。
2. 跑 `node --test core.test.js`、重建、`smoke.mjs`。
3. `plugin_manager` 先 `remove_bundle` 再 `install_bundle`（同一包名，install 会拒绝覆盖已安装包）。
4. 刷新页面后确认卡片右下角的版本号已更新——**只看到槽位仍在注册不足以证明新版已加载**。
