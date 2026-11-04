# DSH 数据源

基于 `dsh-sql 0.5.9` 的本地定制版 `0.6.0-local.2`。保留原有 SQL 查询与只读事务能力，新增独立的数据源管理页面。本包不是上游正式发布。

## 使用

DSH 左侧的「数据源」位于「插件」与「自动化任务」之间。点击后在独立页面左侧选择 MySQL、PostgreSQL 或 SQLite，在右侧填写连接信息，点击「测试连接」或「保存数据源」。已保存连接显示在左侧，点击可以编辑或删除。保存后下一次工具调用直接读取新配置。

- MySQL：主机地址、端口（默认 3306）、数据库名称、用户名、密码。
- PostgreSQL：主机地址、端口（默认 5432）、数据库名称、用户名、密码。
- SQLite：本机已有数据库文件的绝对路径；不自动创建文件，不使用隐式内存数据库。
- 名称、描述支持中文。名称忽略大小写去重。
- 编辑时密码留空会保留已保存密码。输入新值替换；勾选「清除已保存的密码」删除凭据。

仅向模型注册 `sql_list`、`sql_query`、`sql_schema`。没有连接时会提示先添加，不产生默认连接。SQL 查询保留真实 `columns` / `rows`，支持 `table` / `csv` / `json` 输出，最多返回 1000 行。MySQL / PostgreSQL 每次查询使用只读事务；SQLite 以只读方式打开。保留引擎相关 SQL 校验，拒绝写入、多语句、行锁和修改型 PRAGMA。

## 本地状态与密码

连接元数据写入当前 profile 下的 `datasources/connections.json`，通过同目录临时文件及原子重命名保存。元数据只含连接名称、类型、目标及描述；不含密码。

密码通过 DSH 原生 `credentials` record API 保存在 `sql/` 所有者作用域，保护方式与模型密钥一致，页面、工具和日志不回显。`0.6.0-local.2` 修复了上一版自定义 `database-password` 类型不被原生凭据解析器接受的问题，改用原生 `grant` 类型，沿用 `payload.password` 字段及 `sql/dsh-datasource-<连接ID>-password` 键名；读取仅接受 `grant` 中的字符串密码。已有旧类型记录需由部署方迁移，本包不自动改写它们。

DSH 本地凭据提供器使用受本机文件权限保护的明文存储，**不声称加密**。数据源设置页面只返回 `hasPassword` 布尔值。连接失败使用固定安全文案；不向浏览器或模型返回驱动堆栈及原始凭据错误。

Host 的 `/api/datasources/{list,save,test,remove}` 是 DSH 精确 Fetch 路由，复用当前 GUI 登录态，由 DSH 限制为 owner，执行同源/Host 检查并随插件生命周期卸载；保存、测试及删除只接受 JSON POST。

## 开发与安装

要求 Node.js 24+ 和 DSH 0.2.1-rc.5+。在独立源码目录安装驱动并运行验证：

```powershell
pnpm install --ignore-scripts
pnpm test
pnpm run check
pnpm pack --pack-destination <profile之外的归档目录>
```

使用正式 **Desktop carrier** `<安装目录>/resources/runtime/cli/bin/dsh.cmd` 安装打包后的本地归档：

```powershell
& '<安装目录>\resources\runtime\cli\bin\dsh.cmd' plugin --profile desktop add <dsh-sql-0.6.0-local.2.tgz>
```

该官方桌面入口会调用 `dsh-desktop-host/lib/cli.js` 管理 Desktop。不能直接调用通用 `dsh` 的 `lib/bin.js` 管理 desktop，也不手工修改 profile 依赖或补丁。包名与插件行 ID `sql` 保持一致，替换已有 `dsh-sql`。本版不启动上游自动更新控件，防止本地定制被普通更新覆盖。

没有 Host HMR 时需重启已有 DSH，让 Host 工具注册和客户端模块一起更新。刷新浏览器不等同于重启 Host。不要为更新 GUI 启动替代服务。

回退通过同一官方 CLI 安装 `dsh-sql@0.5.9` 或更新前归档，再重启 DSH。本版元数据和凭据保持保留；原版不读取本版页面元数据，不会自动把连接密码写回 YAML。

## 从 0.6.0-local.1 修复已有凭据

源码仓的 [修复脚本](./scripts/repair-native-credentials.mjs) 只匹配连接元数据中的本插件记录，把旧 `database-password` 类型改为原生 `grant`；密码及其他凭据的值保持不变。脚本使用 DSH 自带解析器、跨进程写锁和原子写入，既不输出密码，也不复制凭据备份。脚本不包含在运行时安装包中，应从本仓库执行。

先在合成夹具上验证，再检查实际文件。下例默认只检查，确认结果后在最后一条命令增加 `--apply` 执行：

```powershell
$env:ELECTRON_RUN_AS_NODE = '1'
& '<安装目录>\DeepSeek Harness.exe' .\scripts\repair-native-credentials.mjs --host-root '<安装目录>\resources\app.asar\dsh' --self-test
& '<安装目录>\DeepSeek Harness.exe' .\scripts\repair-native-credentials.mjs --host-root '<安装目录>\resources\app.asar\dsh' --metadata-path '<profile目录>\datasources\connections.json' --credentials-path '<DSH_HOME>\.credentials.yaml'
```

安装 `0.6.0-local.2` 后完整退出并重新打开 DSH，避免旧进程再次写出自定义类型。数据源插件独立于 DataHub 应用，只更新插件及本机 DSH 配置，不涉及 DataHub 业务代码、数据库迁移或应用部署。更新说明见 [CHANGELOG](./CHANGELOG.md)。

## 验证边界

后端自动测试使用真实临时 SQLite 文件，并验证只读 SQL、1000 行截断、配置即时生效、并发保存、凭据保护及安全关闭。Host 路由测试使用校验原生类型枚举的 credentials 接口桩，覆盖旧自定义类型拒绝、合法 `grant` 密码记录的持久化与重载，以及响应不回显密码；测试凭据均为合成夹具，实际原生解析器兼容性由部署回归验证。桌面浏览器夹具验证本包实际客户端代码，但不能代替已有 DSH GUI 在线验收。MySQL / PostgreSQL 需要实际数据库连接才能确认网络、认证和服务端权限。

SQLite 沿用原版同步执行方式；工具的 60 秒超时与 AbortSignal 无法硬抢占已经运行的同步 SQLite 长查询。

许可证与来源见 [LICENSE](./LICENSE) 和 [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md)。
