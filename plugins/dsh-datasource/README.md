# DSH 数据源接入

本地定制版 `dsh-sql 0.9.0-local.13`，支持 MySQL、PostgreSQL、SQLite 的只读接入、原始目录管理、源表启停、问题及业务域辅助选表。通过 `datasourceCatalog` 宿主服务为独立的数据标注插件提供目录、标注存储和会话绑定；标注页面与 AI 标注由 `dsh-data-annotation` 提供。Cube.js 建模和查询接入留待后续，本版字段启停仅作为标注范围保存，不改变普通 SQL 查询权限。

## 初始化独立管理库

新建管理库：准备专用 MySQL 管理数据库，在明确选中的空管理数据库执行 [完整初始化 SQL](migrations/001-management.sql)，建立 schema 7。插件启动只校验结构和版本，不自动建表、升级或清库。

现有 schema 6：停止所有插件实例并备份管理库，手工执行 [v6 → v7 关系与全局保存升级 SQL](migrations/004-relation-results.sql)，再安装配套新版数据源和标注插件。新增关系画布与每源最新全局保存记录，保留原表字段标注，不自动认可旧成果。升级账号需创建/删除过程及建表权限；MySQL DDL 隐式提交，脚本不能回滚已创建的表，失败时应检查实际状态后处理。

现有 schema 5：先执行 [v5 → v6 标注升级 SQL](migrations/003-data-annotation.sql)，再执行 004 升级至 v7。现有 schema 4：先执行 [v4 → v5 增量升级 SQL](migrations/002-question-origin.sql)，再依次执行 003、004；每一步均需停用使用该库的实例并备份。

其他旧版结构若允许舍弃管理数据，可停止相关实例后人工执行 [一次性重建清理 SQL](scripts/reset-management.sql)，随后执行完整初始化 SQL。清理只列出插件自己的表，不删除数据库，也不在正常启动中执行。增量升级不使用该清理脚本。

管理库十二张表：`dsh_management_profiles`、`dsh_management_migrations`、`dsh_sources`、`dsh_source_catalogs`、`dsh_source_tables`、`dsh_questions`、`dsh_question_links`、`dsh_flow_bindings`、`dsh_table_annotations`、`dsh_field_annotations`、`dsh_relation_canvases`、`dsh_annotation_results`。保存当前配置、目录、启停、问题关联、表字段标注、关系画布和每源一条最新全局认可；无历史快照，不保存任务队列、运行详情或样例行。不自动导入本地 JSON。

在插件管理库弹框填写连接参数。管理账号需要能完整查看该专用 schema 的对象元数据并读写管理表；含其他可见表、视图、例程、事件、触发器或跨库外键的目标会被拒绝。运行期间不要由外部工具向管理库加入业务对象。管理库目标固定，更换使用新的 DSH profile。业务源不能指向已识别的管理库目标。

源密码和管理密码均由 DSH 原生 grant 凭据服务保存，页面不返回明文，管理表只存凭据引用。其保护仍依赖本机凭据提供器和文件权限。

## 接入与选表

数据源默认列表展示名称、类型、描述、连接状态、表数、创建时间及启停/编辑/更多删除。支持名称搜索、类型与状态筛选、分页、批量启用及删除已选。全选覆盖当前筛选的全部分页，保留筛选范围外已有勾选。删除已选包括全部勾选记录，确认框列出待删名称和数量；逐项删除时移除成功项，失败项保留勾选并展示原因，重试只处理失败项。数据源删除仅移除连接配置及目录、关联成果，不删除业务库数据。列表打开对启用源测试一次连接，不进行空闲状态轮询。表数来自最近成功目录，未扫描显示空值。

点击名称进入数据表清单，读取真实表、字段、原始注释。MySQL 保留批量元数据读取。打开详情尝试刷新（30 秒内成功过则跳过），详情保持打开时每 30 分钟刷新，失败保留上次目录并人工重试。刷新不做全表样例或 MAX 查询。

新发现表默认停用，刷新后提示并定位新增集合，可返回全部表。复选框只表示批量操作对象，启用开关是已保存状态；全选作用于当前筛选结果且跨分页，清除全选不改变启停。支持搜索、业务域、空表及近 30/60/120 天筛选、仅看已选与批量启停。表名打开原始字段只读详情，按需读取样例。源停用后保留目录和表状态，不再提供普通查询，也不扫描或调用 AI。

AI 辅助选表包含问题与业务域两个区域。问题独立于数据源保存：问题必填，答案可空，新增/编辑保存本身不调用 AI。问题列表用标签区分“原问题”和“泛化问题”；新手工输入为原问题，编辑保留来源，只有原问题可泛化，界面及后端共同限制。历史来源不明的记录显示“来源待确认”，仍可维护和用于选表。编辑弹窗按表分条展示关联，完整表名为主，注释次要，字段及依据在详情中分开展示。

问题列表顶部提供“泛化问题”，打开独立窗口搜索并勾选 1～N 个原问题，选择与选表参考独立。泛化以所选原问题及其答案为共同主要参考、其他原问题为提问习惯参考，先读取当前数据源完整表结构、字段及注释，再按需要读取普通表的受控样例；不再把原指标当作唯一方向。整批目标生成 15～20 条跨业务方向、有真实表字段依据的问题，不随参考数量倍增；支持不足时可少于目标并说明原因。未读取业务样例时明确提示仅依据结构生成。候选支持滚动查看、编辑、全选和取消全选，展开可核对本次参考问题、支持表字段及用途。确认可原子保存 1～20 条为泛化问题，并默认选入当前依据；单参考沿用原问题 ID，多参考不指定唯一来源，不长期保存参考列表。生成及确认时核对全部参考版本，任意参考更新或删除则拒绝保存。候选答案为空，不复制原问题关联；确认时将服务端草稿中的真实表字段依据与新问题在同一事务保存，再次打开即可查看。候选正文改过时保留依据并标为待重新分析，避免误用修改前的结果。取消不新增问题。泛化在同一次 AI 会话中补齐所选原问题缺失或失效的表字段关联；已有有效关联或有效空结果直接复用。每个待分析原问题必须明确提交关联或空列表，遗漏和失败不算分析完成。原题分析在成功提交时原子保存，候选仍待确认；取消候选保留已完成的原题成果。结构校验不能替代真实 AI 生成质量验收。

业务域由目录识别并保存，支持全选，不需要预设字典，识别本身不启用表。选表依据左右区域统一在标题下显示已选数量及右侧全选；左侧完整显示全部问题，两侧列表各自滚动，全选覆盖完整集合。问题条目保留独立边框、整条可点击，选中只显示复选框勾选，不增加底色。问题列表全选作用于当前搜索结果全部分页，可删除全部已选问题及其关联；确认框列出完整待删清单，部分失败保留失败项供重试。AI 操作显示加载状态与真实经过时间；后台目录每页读取 20 张表，减少工具往返。

各类弹窗采用稳定目标高度并限制在视口内；标题及底部操作固定，超出内容内部滚动。问题列表继续分页，最后一页少数据时不收缩窗口，分页与完成按钮位置保持稳定。配置、编辑、详情、候选及删除确认沿用各自大小档位。当前管理库为 schema 7，旧库按上文升级链处理。

选表依据分别显示可复用关联、已分析无关联及待分析数量。点击 AI 选表时，问题在当前数据源有完整且版本、表结构均有效的关联则直接复用；显式已分析无关联结果也直接复用，不额外推荐表。只将未分析或失效的问题交给 AI，并要求逐题明确提交结果。空结果保存在现有目录上下文中，与关联原子维护，可跨重启复用；问题版本、连接或完整目录结构变化后失效，同结构刷新、业务域识别及启停不影响有效空结果。界面区分“尚未分析关联”“已分析，未找到关联表”“关联待重新分析”。全部问题均可复用或只选择业务域时直接形成推荐草稿，不创建 AI 会话。旧版保存时丢失的关联无法还原，首次选表需分析一次。保存关联依据并展示推荐草稿。结果默认勾选“此前启用表 ∪ 所选业务域匹配表 ∪ AI 推荐表”，已启用与 AI 推荐分开显示标签，保留业务域匹配标签，不在推荐列表输出长段理由。仅推荐结果弹窗采用表格内部滚动，支持全选当前搜索结果并保留范围外勾选；其他列表继续分页。用户调整后确认才保存启停；取消不改启停，已完成的问题关联成果仍保留。并发目录、问题或表状态变化会拒绝覆盖，要求重新核对。

## 业务数据库只读

业务数据源绝对不执行 DML、DDL、注释写回、授权或管理表建表。源/表开关、问题、业务域、检测结果全部写独立管理库；管理连接不会注册给模型。

业务连接强制只读，MySQL 关闭多语句并使用只读事务，PostgreSQL 使用只读事务、固定查询搜索路径和扩展协议，SQLite 仅只读打开已有文件。目录、空表、MAX 和样例查询由插件固定构造，不执行 AI 提供的检测 SQL。部署应使用已有只读业务账号，插件不自动创建账号或修改权限。

普通聊天保留 `sql_list`、`sql_schema`、`sql_query`。只访问当前启用的源和表，查询最多 1000 行；`node-sql-parser` 三方言 AST 校验递归检查 JOIN、CTE、子查询及 UNION，拒绝写入、跨库、未知函数、外部关系与不支持语法。查询被拒绝时可调整为支持的只读 SELECT，查看结构使用 `sql_schema`。此子集不等同于支持数据库的全部查询语法。特殊引擎表、外部/虚拟表、PostgreSQL 分区父表与启用行级策略的表不提供普通查询和固定采样/检测。

AI 接入会话只能通过 `datasource_task` 读取本次目录和受控样例、提交结构化成果，不能调用普通 SQL 工具扩大范围。每个操作一个 DSH 会话，订阅原生事件后发送，以成果提交完成判定成功。AI 任务由后端持有，页面每秒查询状态，离页只停止观察；显式取消、超时、源停用和重启使旧会话失效，晚到成果不能保存。提交与取消并发时以管理库实际提交结果为准。等待 AI 不占用数据库事务。任务状态、选表草稿和泛化候选仅保留在当前进程，不跨重启恢复。

## 供 Web 后端调用

DSH 页面与 Web 后端复用同一套处理器、运行状态和管理库。Web 页面由自己的后端转发，不直接连接管理库。随插件提供的默认配置已开启本机 HTTP 接口，端口为 `17861`；在 DSH 的 sql 插件配置中可将 `enabled` 改为 `false` 关闭，或调整端口：

```yaml
config:
  internalApi:
    enabled: true
    port: 17861
```

内部入口固定绑定 `127.0.0.1`，无需新增登录或 API Key。Web 后端使用 `http://127.0.0.1:17861`，不要把此端口代理到公网；接口拒绝浏览器 Origin 与非本机 Host。同机的其他进程可访问此入口。容器调用需共享网络命名空间或安排等效内部通道，容器各自的 localhost 并不互通。端口冲突会报错，不自动换端口。管理库初始化接口仅保留在 DSH 页面入口。

以下路径统一以 `/api/datasources/` 开头；POST 使用 `Content-Type: application/json`，响应为 JSON，错误返回 `{error}`，版本冲突为 409：

| 路径 | 方法与参数 | 结果 |
| --- | --- | --- |
| `list` | GET | `{items}`，不含密码 |
| `save` | POST，名称、engine、连接参数；更新附 `id,revision` | `{item}`；密码只在创建/修改时提交 |
| `test` | POST，连接参数或已有源信息 | 连接测试结果 |
| `remove` | POST `{id,revision}` | `{ok:true}` |
| `source-status` | POST `{items:[{id,revision,enabled}]}` | 逐项 `{results}` |
| `questions-list` | POST `{id}`，id 为数据源 ID | `{items}` |
| `questions-save` | POST `{text,answer?}`；更新附 `id,version` | `{item}`；问题独立保存 |
| `questions-remove` | POST `{id,version}`，id 为问题 ID | `{ok:true}` |
| `flow-state` | POST `{id}` | `{state}`，含整数 revision、目录、问题和当前有效草稿 |
| `flow-action` | POST `{id,action,revision,...}` | `{state}`；action 为 scan、ensure-scan、detect-freshness、set-tables、confirm-selection、confirm-question-draft 或 cancel |
| `flow-samples` | POST `{id,tableId,snapshotId}` | 固定限量样例 |
| `ai-tasks` | POST `{id,action,revision,...}` | 202 `{task}`；action 为 detect-domains、suggest 或 generalize-question |
| `ai-tasks` | GET `?taskId=...` 或 `?sourceId=...`，二选一 | `{task}`；sourceId 返回最新任务或 null，未知 taskId 为 404 |
| `ai-tasks/cancel` | POST `{taskId}` | `{task}`，取消中或已有终态 |

选表任务附 `questionIds` 和/或 `domains`；泛化任务附 `questions:[{id,version}]`。AI 的工作目录由服务配置决定，不接受调用方提交 cwd。受理后读取目录、版本等业务检查可能失败，202 不表示执行成功。

```powershell
$base = 'http://127.0.0.1:17861'
$state = (Invoke-RestMethod "$base/api/datasources/flow-state" -Method Post -ContentType 'application/json' -Body '{"id":"数据源ID"}').state
$body = @{ id = $state.id; action = 'suggest'; revision = $state.revision; questionIds = @('问题ID'); domains = @() } | ConvertTo-Json
$task = (Invoke-RestMethod "$base/api/datasources/ai-tasks" -Method Post -ContentType 'application/json' -Body $body).task
Invoke-RestMethod "$base/api/datasources/ai-tasks?taskId=$($task.taskId)"
```

任务快照包括 `taskId,sourceId,kind,status,startedAt,finishedAt,sessionId,result,error`。状态为 `running/cancelling/succeeded/failed/cancelled`；成功结果只提供 revision 和适用的 draftId/questionDraftId，完成后重新读取 flow-state。任务中的 sessionId 仅用于 DSH 会话诊断，不是访问凭证。每插件每数据源至多一个活跃 AI 任务，冲突为 409 并附当前 taskId；不会排队。响应丢失可按 sourceId 恢复观察，不自动重复创建。终态保留一小时，每插件最多 200 个，重启后任务查询为 404，已落库成果不丢失。

推荐确认沿用 `flow-action` 的 `{id,action:'confirm-selection',revision,draftId,selectedTableIds}`；泛化候选确认使用 `{id,action:'confirm-question-draft',revision,draftId,candidates:[{id,text}]}`。取消候选/推荐草稿使用 `action:'cancel'` 并传 questionDraftId/draftId，区别于取消运行中的 AI 任务。

local.11 起，三个 AI action 不再经 flow-action 执行，调用方与两个插件须成套更新。local.12 使用管理库 schema 7、共享服务 version 2，提供关系画布及全局保存存储。local.13 将共享服务升至 version 3，关系 AI 按业务主题批量原子保存多个草稿画布，允许跨画布复用表和关联，按主表与完整关联集合去重。主表保存在现有 content JSON 中，管理库仍为 schema 7；旧画布保留，未指定主表的旧内容保持兼容。`readSavedResults(sourceId)` 在同一事务校验启用源、当前指纹和全局保存记录后取数；未保存或成果变动返回 409。后续建模必须使用此入口取数，长任务落库前再核对起始 fingerprint；本仓库本轮没有实现建模入口。标注接口及同端口使用见配套标注插件 README。

## 时效检测

单独点击时效检测时，对当前源全表执行只读存在性查询判断空表，不用估算行数或全表 COUNT。日期时间类型字段按 update/modify、create/add、time、其他日期字段排序，最多尝试五列，MAX 全空时回退。无字段、全空、失败与未检测分开保存，查看可见实际依据字段及检测时间。

最近数据时间是依据选中字段测得的时间，不等同于数据库物理最后写入时间。日期、无时区墙钟和带时区时间保持各自语义，不用目录刷新时间填充。SQLite 无日期声明的字符串/数字字段不猜测时间。

## 开发、打包和安装

要求 Node.js 24+、DSH 0.2.1-rc.5+。在本插件目录运行：

```powershell
npm ci --ignore-scripts
npm test
npm run check
npm pack --ignore-scripts
```

验证包含必要后端测试、语法与打包检查，以及配套标注插件新增画布/第四步的受控浏览器流程。管理库测试用内存 SQLite 转译 SQL，未替代真实 MySQL 上执行升级脚本或 DSH＋模型端到端验收。

正式安装使用 Desktop carrier `<安装目录>/resources/runtime/cli/bin/dsh.cmd`：

```powershell
& '<安装目录>\resources\runtime\cli\bin\dsh.cmd' plugin --profile desktop add '<本地归档.tgz>'
```

包名与插件 ID `sql` 不变，不手工修改 profile 依赖或补丁。需要 Host 重载时保存工作并完整重启 DSH；普通浏览器刷新不等于重启 Host。不启动替代服务。本版不启用上游自动更新控件。

SQLite 使用原版同步查询方式，AbortSignal 无法硬抢占已开始的同步长查询。许可与来源见 [LICENSE](LICENSE)、[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。历史版本及凭据修复记录见 [CHANGELOG](CHANGELOG.md)。
