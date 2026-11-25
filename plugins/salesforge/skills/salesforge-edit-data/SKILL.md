---
name: salesforge-edit-data
description: 在销售管理系统里新建、修改、删除和移交数据：客户、渠道、联系人、客户部门、项目（含梳理记录和项目分析）、日报、周计划、周报、销售目标。先查到准确的 ID 和现有内容，只改用户要求改的字段，文字照用户原话写；删除和移交只发起确认卡片，由用户点确认后才执行。用户说「把某某改成…」「新建一个客户/项目」「加个联系人」「项目推进到商务招标了」「删掉这条日报」「把这几个客户移交给张三」「给李四定个目标」时使用。
---

# 维护销售数据

插件以用户本人的账号写入销售管理系统，权限和用户在网页上一样：没有权限的操作，系统会拒绝。

## 开始前

- 任何工具返回 kind 为 `salesforge-auth-required` 时：把 message 原样转告用户，停下等用户回复「继续」，不要重试或绕过。
- 用户管理、角色、部门、系统配置、产品列表不能通过插件修改，请用户到销售管理系统网页里操作。

## 第 1 步：找准是哪一条

1. 客户、渠道用 `sales_search` 按名称找 ID；人员用 `sales_search`（`target="people"`）。
2. 要改的是下属数据（联系人、部门、梳理记录）或要看现有内容时，用 `sales_get_record` 查详情：客户和渠道会列出联系人（contactId）和部门（deptId），项目会列出梳理记录（reviewId）和项目分析。
3. 日报用 `sales_query_work_reports`（`mode="daily"`）按日期、对象找，表里有「日报ID」；周报用 `mode="weekly_reports"`，表里有「周报ID」。
4. 销售目标：个人目标用 `sales_targets`，部门目标用 `sales_targets`（`scope="team"`），表里有「部门ID」。
5. 找到多条（同名客户、同一天几条日报）或一条都没找到时，把候选列给用户确认，不要猜。

## 第 2 步：新建和修改

| 要做什么 | 调用 |
|---|---|
| 新建客户或渠道 | `sales_save_customer`：`action="create"`，`targetType`，`name`；客户可加 `industry`、`address` |
| 改客户或渠道的名称、行业、地址 | `sales_save_customer`：`action="update"`，`targetId`，只给要改的字段 |
| 加联系人、改联系人 | `sales_save_customer`：`action="add_contact"` 或 `"update_contact"`（要 `contactId`），可给 `position`、`phone`、`deptId` |
| 加客户部门 | `sales_save_customer`：`action="add_dept"`，`deptName` |
| 新建项目 | `sales_save_project`：`action="create"`，项目名、客户、客户联系人、产品、预计金额（万元）、预计签约日期都要有，缺了先问用户 |
| 改项目阶段、风险、金额、签约日期、备注、渠道 | `sales_save_project`：`action="update"`，`projectId`，只给要改的字段 |
| 记项目梳理、改梳理记录 | `sales_save_project`：`action="add_review"` 或 `"update_review"`（要 `reviewId`） |
| 项目分析（需求、技术认可、决策链、合作伙伴、竞争对手） | `sales_save_project`：`action="save_analysis"`，只给要改的项 |
| 新建日报 | `sales_draft_work_report` 生成草稿，用户在卡片上点「提交日报」才写入 |
| 改日报 | `sales_save_work_report`：`action="update_daily"`，`reportId`，只给要改的字段；只能改自己的日报 |
| 保存周计划 | `sales_save_work_report`：`action="save_weekly_plan"`；先用 `sales_query_work_reports`（`mode="weekly_plan"`）读出现有条目，改好后把完整的条目列表传回去（会整份替换） |
| 保存周报 | `sales_save_work_report`：`action="save_weekly_report"`，`workSummary`、`supplement` |
| 设置销售目标 | `sales_save_target`：个人给 `userName` 或 `userId`，部门给 `deptId`；只给要改的季度 |

文字内容（日报、周报、梳理记录、备注）照用户的原话写：只改正明显的错别字和标点，不扩写、不润色、不补充用户没说的内容。

改完后按工具返回的 `changes` 用一两句话告诉用户改了什么，例如「已把项目 A 的阶段从方案论证改成商务招标」。系统拒绝时，把返回的原因转告用户。

## 第 3 步：删除和移交

- 删除用 `sales_delete`：`type` 是数据类型，`ids` 是 ID 列表（一次最多 20 条）；删联系人和客户部门时要给 `parentId`（所属客户或渠道的 ID）。
- 移交负责人用 `sales_transfer`：`type` 是 customer、channel 或 project，`ids`，接收人 `toUserName` 或 `toUserId`；移交客户、渠道时默认一并移交其下跟进中的项目（`includeProjects`）。
- 这两个工具不会马上执行，只在对话里显示确认卡片。调用后告诉用户：请在卡片上核对，点「确认删除」或「确认移交」后才会执行；删除后不能在系统里恢复。不要说已经删除或移交。
- 工具返回的 `skipped` 里是找不到或不在数据范围内的 ID，要告诉用户这几条没放进卡片。
- 不要用别的办法代替删除，例如把日报内容改空。

## 做不到的事

- 管理用户、角色、部门、系统配置和产品列表。
- 修改别人写的日报和周报（管理员除外，由系统判断）。
- 调用系统的「生成周报」：要写周报时，读这一周的日报和周计划，按用户的意思整理，给用户看过再用 `sales_save_work_report` 保存。
