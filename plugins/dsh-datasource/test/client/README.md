# 数据源客户端浏览器测试

直接运行 `node test/client/browser.mjs`。需要可用的 Playwright 和桌面 Chromium；不改动插件生产依赖。可用以下环境变量指定已有工具：

- `DSH_PLAYWRIGHT_MODULE`：现有 `playwright` 模块的绝对路径，未设置时按 Node 常规模块规则查找。
- `DSH_CHROME`：已有 Chromium/Chrome 可执行文件的绝对路径，未设置时使用 Playwright 自带浏览器。
- `DSH_CLIENT_TEST_OUTPUT`：截图、JSON 报告及固定 React 测试依赖的缓存目录，默认使用系统临时目录。
- `DSH_CLIENT_UNDER_TEST`：可选，待测 `client.js` 的绝对路径，可指定已安装的插件客户端；默认测试本源码目录的客户端。JSON 报告记录实际待测路径和 SHA-256。
- `DSH_REACT_UMD`、`DSH_REACTDOM_UMD`：可选，已有 React 18.3.1 开发版 UMD 文件。未提供时，从官方 npm registry 下载固定版本包，只提取 UMD 文件到测试缓存；不运行 npm install。

测试通过 Playwright request routing 提供真实客户端和 React，浏览器内的 fixture 替换全部数据源 fetch。不会启动服务器，不连接真实数据库，不创建真实模型任务、DSH 会话或改动当前 GUI。所有库、表、字段、问题与会话值均为合成测试数据。

每个桌面尺寸（1366×768、1440×900、1920×1080）都执行完整链路：空状态与创建默认值；连接测试、密码保留/清除和引擎切换；创建、取消删除和明确删除；整行/名称进入与返回；问题整理、编辑、手动添加、选择保存；轮询草稿/焦点与 revision 冲突；13 条完整问题快照和分批预览；明确开始、进度、重试、取消与会话打开/降级；真实字段范围选择；关系 ID、字段和基数编辑；先确认表，再复核关系来源，最后确认关系；来源切换时中止旧请求，以及横向溢出和浏览器错误检查。

另在 1366×768 的 `sandbox="allow-scripts"`、不含 `allow-same-origin` 的 blob iframe 内验证整行/键盘进入、页签和返回，复现旧 hash 导航的安全环境，确保客户端导航不修改 URL。还验证绝对工作区路径校验、留空不发送 `cwd`、问题选项变化使预览失效，以及终态遗留排队批次不锁住新分析。

这是客户端交互验收。真实数据库、模型执行、Host 会话接口和已安装 GUI 的集成验收由各自后端/安装验收负责，不能以本 fixture 的通过结果替代。
