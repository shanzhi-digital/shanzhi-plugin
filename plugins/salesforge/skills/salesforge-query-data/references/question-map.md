# 问题 → 工具和参数对照

金额单位都是万元，日期格式 YYYY-MM-DD。人员参数（`salesName`/`salesId`、`reporterName`/`reporterId`）都会先核对查看范围。

## 账户和人员

| 问法 | 工具 | 参数 |
|---|---|---|
| 连上了吗、当前是谁 | `sales_config` | 不传，或 `action="get"` |
| 我是什么角色、能看哪些数据 | `sales_config` | `action="profile"` |
| 我能看哪些人、某人的 ID | `sales_search` | `target="people"`，`keyword` 可选 |

## 客户和渠道

| 问法 | 工具 | 参数 |
|---|---|---|
| 某客户/渠道的 ID | `sales_search` | `keyword` 填名称的一部分（同时搜客户和渠道） |
| 客户列表、按行业或负责销售筛 | `sales_query_customers` | `customerName`、`industry`（精确，如 政府、教育、企业、金融、医疗）、`salesName`/`salesId` |
| 某段时间新增的客户 | `sales_query_customers` | `createdFrom`、`createdTo` |
| 超过 N 天没跟进的客户 | `sales_query_customers` | `minDaysSinceFollow=N`（本地扫描，不能翻页） |
| 按未跟进天数从多到少排 | `sales_query_customers` | `sortBy="daysSinceLastFollow"` |
| 渠道的同类问题 | `sales_query_channels` | 名称参数是 `companyName`，没有行业，其余同客户 |

## 项目（商机）

| 问法 | 工具 | 参数 |
|---|---|---|
| 项目列表 | `sales_query_projects` | `mode="list"`（默认） |
| 某阶段、某风险的项目 | `sales_query_projects` | `projectStatus`、`projectRisk`（取值见 metrics.md） |
| 某客户/渠道的项目 | `sales_query_projects` | 先 `sales_search` 拿 ID，再传 `customerId` 或 `channelId`（只能用于 list） |
| 今年第几季度预计签约的 | `sales_query_projects` | `quarter`（1～4，只算今年） |
| 某段时间预计签约的 | `sales_query_projects` | `expectedSignFrom`、`expectedSignTo`（本地扫描） |
| 按金额排、前 N 大 | `sales_query_projects` | `sortBy="expectedAmount"`，`pageSize=N`（本地扫描） |
| 金额在某个范围 | `sales_query_projects` | `minAmount`、`maxAmount` |
| 多久没梳理的项目 | `sales_query_projects` | `minDaysSinceFollow`（本地扫描） |
| 已签约 / 丢单的项目 | `sales_query_projects` | `projectStatus="项目签约"` 或 `"项目丢单"`（会自动带 `includeArchived`） |
| 项目总数、总金额、必签金额、风险金额 | `sales_query_projects` | `mode="summary"`，可加阶段、风险、季度、金额、负责销售、新增时间、`includeArchived`；不能加客户、渠道、预计签约日期、排序、分页 |

## 看板

| 问法 | 工具 | 参数 |
|---|---|---|
| 本月签了多少、新增多少客户（部门范围） | `sales_dashboard` | `view="home"` |
| 我的目标完成多少、还差多少 | `sales_dashboard` | `view="sales"`，`period` 选 `year`/`quarter`/`month` |
| 团队目标完成情况、各部门完成率 | `sales_dashboard` | `view="sales"`，`scopeType="team"` |
| 商机储备多少、风险金额多少 | `sales_dashboard` | `view="opportunity"`，`period` 默认 `quarter` |
| 新增了多少项目、多少金额 | `sales_dashboard` | `view="market"`，`period` 默认 `year` |

看板不能按某个人查（没有人员参数），只能看自己或自己的团队。

## 汇报

| 问法 | 工具 | 参数 |
|---|---|---|
| 日报、拜访记录 | `sales_query_work_reports` | `mode="daily"`（默认），`startDate`、`endDate`、`reporterName`/`reporterId` |
| 某客户/渠道的跟进记录 | `sales_query_work_reports` | `targetType`（`customer` 或 `channel`）+ `targetId` |
| 某周的周报 | `sales_query_work_reports` | `mode="weekly_reports"`，`weekStartDate` 填那周任意一天 |
| 某人某周的周计划 | `sales_query_work_reports` | `mode="weekly_plan"`，不填人就是自己；不能分页 |

## 目标

| 问法 | 工具 | 参数 |
|---|---|---|
| 我今年的年度和各季度目标 | `sales_targets` | `scope="personal"`，`year` 可选 |
| 各部门的目标和完成率 | `sales_targets` | `scope="team"`，`year` 可选 |
| 完成了多少、还差多少 | 用 `sales_dashboard`（`view="sales"`），不是 `sales_targets` | |

## 常见报错

| 报错 | 原因和处理 |
|---|---|
| 不认识参数 xxx | 参数名写错了，按报错里列出的可用参数改 |
| 用本地筛选或排序时不分页 | 去掉 `pageNum` |
| xxx 只能在 mode="list" 时使用 | 汇总不排序、不分页：去掉 sortBy、sortOrder、pageNum、pageSize；客户、渠道、预计签约日期和跟进天数条件汇总时也能用 |
| 必须是 YYYY-MM-DD 格式的日期 | 日期写成 2026-11-24 这种格式，并且是真实存在的日期 |
