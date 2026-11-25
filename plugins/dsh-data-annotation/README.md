# 数据标注

独立 DSH 插件 `dsh-data-annotation 0.1.0-local.11`。依赖配套 `dsh-sql 0.9.0-local.13` 提供的 `datasourceCatalog` version 3 和管理库 schema 7，不重复配置业务库。

## 功能

侧栏“数据标注”显示已启用数据源、启用表数量、整体标注状态和最近标注时间。进入后包含表标注、字段标注、表关系标注、标注确认四步，可自由切换。原表和字段备注只读，人工标注保存在专用管理库，不写回业务库。

红色未标注；黄色人工未确认；绿色人工已确认。AI 生成和编辑保存均不自动确认；已确认内容发生修改后回到黄色。支持单项/批量编辑与确认、筛选、跨分页选择、仅看已选。导入、导出为禁用占位。

字段支持单项及批量启停，默认启用，停用保留已有标注。左侧表进度为“人工已确认的启用字段数 / 启用字段总数”。完全标注要求所有启用表的名称及其启用字段均人工确认；零启用表显示未标注。字段启停本版用于标注范围和有效配置保存，Cube.js 建模及查询执行限制后续实现，当前普通 SQL 权限不受其控制。

AI 辅助只处理选中的未确认对象；不覆盖已确认内容，不读取停用字段或业务样例。表标注生成简短中文业务名称，字段标注说明字段含义，保存后为黄色。离开页面只停止任务观察，重进数据源恢复最新任务；显式点击取消才请求结束后台任务。若提交先于取消完成，以管理库已提交结果为准，页面重新读取状态。目录或标注并发变化拒绝覆盖。AI 仅使用受限的 `data_annotation_task`，不能借源插件普通 SQL 或接入任务扩大范围。

表关系标注按草稿、已标注列出画布，可搜索名称、表及字段。画布支持多表多线、拖动表节点、拖拽或点选字段连线、复合字段配对和 1:1／1:N／N:1 基数。表节点默认仅展示参与关联的字段，展开可查看全部字段，收起后已有连线仍准确连接到保留的字段；展开收起不产生待保存修改。候选表通过独立“＋”按钮添加。选中连线后可通过画布删除按钮、右键菜单或 Delete／Backspace 删除关系，输入区域编辑文字时不触发删线。保存语义内容进入草稿，确认原子保存并人工确认；纯布局调整保留确认。保存期间禁用重复提交，成功后按钮显示“已保存”并弹出短暂提示，再次修改恢复“保存”。失效表字段引用保留供修复并撤销确认，恢复对象不会自动恢复确认。

关系 AI 分析当前源全部启用表和启用字段，按业务查询主题生成零至多个草稿画布，每组有中文业务名称、说明和主表，只包含服务于该主题的关联路径。比如“居家上门服务工单关联分析”可组合工单、区县、老人档案；不能仅因表能连通就把全源堆成一张图。不同画布允许复用表和关联，重复的完整组合不重复新增；整批校验后原子保存，不覆盖已有画布。生成结果分别显示业务画布数与关联连线数。只依据结构推断，不读取业务样例、不宣称真实外键或全量匹配证明。没有可靠业务组合时不创建空画布。旧版大画布保留供查看、编辑或删除，不自动拆分或覆盖。本次保持 schema 7，无需数据库升级。

标注确认的“数据表列表”显示全部启用表，进度分母为表名一项加全部启用字段，灰色轨道样式与标注页一致；“表关系列表”仅显示有效人工确认画布，按关系名称分组，涉及表逐条展示源表、基数和指向目标表的箭头。无文本为红色、有内容但未全确认是黄色、表名和全部启用字段均确认是绿色；画布颜色随其涉及表完成度变化。顶部“保存”全局认可前三步当前成果，允许部分标注，不代替逐项确认。保存成功后按钮置灰显示“已保存”并弹出提示，刷新或重新进入根据服务端状态恢复。每源只保留最新一条认可，语义修改即清空；改回旧内容也需重新保存。纯布局与同结构刷新保留认可。

目录相同刷新保留标注；原备注或字段结构变化取消受影响项确认但保留文本。删除表字段清理单表标注，受影响画布移回草稿保留修复；换库目标通过目录级联清理原标注和画布。AI 效果仍需真实 DSH 验收。

## 安装

先停止使用管理库的 DSH 实例并备份。当前 v6 管理库手工执行数据源插件的 `migrations/004-relation-results.sql`；v5 先执行 003 再执行 004，v4 先执行 002、003 再执行 004。脚本不由插件自动执行。新增关系画布和全局认可两张管理表，升级账号需要建表及创建/删除过程权限。MySQL DDL 隐式提交，不能事务回滚已创建表。

按顺序安装配套数据源包、标注包，再完整重启 DSH。源插件未就绪时标注插件等待依赖服务，管理库配置仍在“数据源”页面。两个插件必须成套使用 schema 7。

```powershell
dsh plugin --profile desktop add '<dsh-sql-0.9.0-local.13.tgz>'
dsh plugin --profile desktop add '<dsh-data-annotation-0.1.0-local.11.tgz>'
```

## 供 Web 后端调用

数据源插件的默认配置已开启 `internalApi`，本插件自动把相同业务处理器注册到同一个本机端口，默认地址为 `http://127.0.0.1:17861`。不另外启动监听器或配置凭据，关闭内部端口后仍可正常在 DSH 使用。Web 页面经自己的后端调用；同一部署共用插件管理库和 profile，不直接读取 DataHub 的其他数据库。

所有路径以 `/api/data-annotation/` 开头，POST 使用 JSON：

| 路径 | 方法与参数 | 响应 |
| --- | --- | --- |
| `sources` | GET | `{items}`，数据源及标注统计 |
| `catalog` | POST `{sourceId}` | `{source,revision,tables,summary}` |
| `action` | POST `{sourceId,revision,operation,kind,items}` | 最新目录；operation 为 edit、confirm 或 enable |
| `ai-tasks` | POST `{sourceId,revision,kind,items}` | 202 `{task}`，仅表示受理 |
| `ai-tasks` | GET `?taskId=...` 或 `?sourceId=...`，二选一 | `{task}`；sourceId 获取最新任务，无任务为 null |
| `relations` | POST `{sourceId}` | `{revision,items}`，草稿、有效确认状态和失效引用 |
| `relation-save` | POST `{sourceId,revision,canvas:{id?,name,description,content,layout}}` | `{revision,canvas}`，语义修改回草稿 |
| `relation-confirm` | POST 同保存请求，或 `{sourceId,revision,canvasId}` | `{revision,canvas}`，原子保存并确认 |
| `relation-remove` | POST `{sourceId,revision,canvasId}` | `{revision,ok:true}` |
| `results` | POST `{sourceId}` | `{revision,saved,tables,relations,summary}`，第四步投影；saved 表示当前成果仍具有有效的全局保存认可 |
| `results-save` | POST `{sourceId,revision}` | `{revision,ok:true}`，全局认可当前成果 |
| `saved-results` | POST `{sourceId}` | 同事务校验和读取当前已全局保存成果，否则 409 |
| `ai-tasks/cancel` | POST `{taskId}` | `{task}`，取消中或当前终态 |

`kind` 为 table、field 或 relation；表条目为 `{tableId}`，字段条目为 `{tableId,fieldName}`，关系 AI 的 items 必须为全部启用表 `{tableId}`，至少两表。编辑附 text，字段启停附 enabled。revision 是非空 opaque 字符串，调用方应原样传递，不能转换成数字。确认、编辑与启停均由同一业务存储校验并保存。画布 content 为 `{rootTableId?,nodes:[{tableId,label}],edges:[{id?,fromTableId,toTableId,pairs:[{fromField,toField}],cardinality}]}`，layout 为以 tableId 为键的坐标对象。rootTableId 表示主表，新 AI 画布必须提供；历史和手工画布可缺省。AI 工具 submit 使用 `canvases:[{name,description,rootTableId,relations:[{fromTableId,toTableId,pairs,cardinality}]}]`，每组独立形成一张画布，允许跨组复用同一关联。

任务快照字段与数据源任务一致：`taskId,sourceId,kind,status,startedAt,finishedAt,sessionId,result,error`。状态为 `running/cancelling/succeeded/failed/cancelled`；成功 result 为 `{revision,count}`，关系任务另含 `canvasCount,canvasIds`（无新增时为 0 和空数组），count 为本次新增各画布的关联连线总数；完成后重新请求 catalog/relations 获取最新数据。目录版本等异步检查失败时任务为 failed；冲突返回 409 和 taskId；不存在或过期 taskId 为 404。每数据源只执行一个标注任务，不排队。页面每秒串行观察任务，HTTP 断开不取消执行；响应丢失后按 sourceId 查询，不自动重发。

任务仅驻留当前进程，终态保留一小时、最多 200 个；重启后刷新目录查看已保存成果，未完成任务需重新发起。local.9 移除旧 `/ai` 长请求接口，local.10 增加关系与全局保存，两个插件及调用方需成套更新至 schema 7。`saved-results` 同时检查和取数，未保存或失效返回 409“请先在标注确认中保存当前成果”。后续建模后端必须从此入口消费；当前尚未开发建模页面和任务。

## 开发验证

Node.js 24+，DSH 0.2.1-rc.5+。工作区开发先安装配套数据源依赖，再链接本地 peer：`npm install --ignore-scripts --legacy-peer-deps`，将 `node_modules/dsh-sql` 链接到 `../dsh-datasource` 的实际位置。

运行 `npm test`、`npm run check` 和 `npm pack --dry-run --ignore-scripts`。接口和会话测试使用受控夹具，不调用真实 AI。新增画布/第四步浏览器验证入口为 `test/client/browser.mjs`：临时目录准备 React 18、React DOM 18 和 playwright-core 后，将 `ANNOTATION_BROWSER_TOOLS` 指向该目录，运行 `node test/client/browser.mjs`；默认使用本机 Edge，可用 `ANNOTATION_BROWSER_EXECUTABLE` 指定浏览器。脚本拦截测试 API，不启动应用服务，退出时关闭浏览器。
