---
name: datahub-ask-data
description: 使用 datahub-ask-data MCP 对授权数据源做问数（列数据源、读模型、写语义 SQL 取真实数据）。当用户要查业务数据、做统计/汇总/排名/趋势，或提到数据源、指标、表、字段时使用。
---

# DataHub 问数

工具由 MCP 提供，认证由客户端处理，不要读取或输出密钥。

1. 不知道有哪些数据源时，调用 `mcp__datahub-ask-data__list_datasource_skills`（参数 `{}`），按 `datasourceName` / 描述选择 `datasourceId`；需要了解已发布的公共查询入口时调用 `mcp__datahub-ask-data__list_public_skills`。
2. 选定数据源后，调用 `mcp__datahub-ask-data__load_skill_through_path` 读取该数据源的 `SKILL.md`、`references/model-index.md`、`references/metric-index.md`，确认可用的 View、字段、指标与口径。
3. 需要底层 Cube 定义时调用 `mcp__datahub-ask-data__load_model_definitions`，传入 `sources`（`skillId` + `views` + `cubes`）。
4. 调用 `mcp__datahub-ask-data__execute_semantic_sql` 取数：`datasourceId` 必填；`sql` 只能查该数据源已发布的公共 View；`limit`/`offset` 控制分页。
5. 回答时说明所用的数据源、口径与过滤条件；结果为 0 行时先核对口径与时间范围，不要编造。

工具不可用或调用失败时如实说明，不编造数据。
