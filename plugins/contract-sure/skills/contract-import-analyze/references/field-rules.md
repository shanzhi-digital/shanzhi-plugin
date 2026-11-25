# 合同字段提取口径

`contract_stage_draft` 的字段和填法。拿不准的字段宁可空着、在回复里请用户补，也不要编。

## 基本字段

| 字段 | 含义 | 填法 |
|---|---|---|
| `contractNo` | 合同编号 | 先看文件名里的规范编号（如 HT-2026-001、SZ2026001），没有再从正文找。都没有就问用户，严禁编造 |
| `contractName` | 合同名称 | 合同标题或项目全称 |
| `contractType` | 合同类型 | 1 = 销售合同（我方供货、提供服务、收款）；2 = 采购合同（我方采购、付款）。判断不了时按上下文先填，并提示用户核对 |
| `totalAmount` | 合同总额 | 人民币「元」的纯数字：去掉逗号、货币符号；原文是「万元」要乘以 10000。含税价优先，原文只写不含税价时在回复里注明 |
| `taxRate` | 税率 | 百分比数字，例如 6、9、13；没写就不传 |
| `signDate` | 签订日期 | YYYY-MM-DD；合同没写签订日期就填 null，不要用落款页以外的日期代替 |
| `startDate`、`endDate` | 合同起止日期 | YYYY-MM-DD；只写了「自签订之日起 12 个月」这类时，能算就算出来并在回复里说明是推算的，算不出就填 null |
| `partyAName`、`partyBName` | 甲方、乙方户名 | 完整的单位法定名称，和公章、开户名一致。后面银行流水自动对账靠它，不要写简称 |
| `sourceFilePath` | 原件路径 | 用户给的原始文件路径，入库时自动归档。履约系统只能归档 PDF、Word、Excel 和图片 |

## 付款/回款节点 `nodes`

每个节点一项：

| 字段 | 填法 |
|---|---|
| `nodeOrder` | 从 1 开始按合同顺序编号 |
| `nodeName` | 节点名称，如 预付款、到货款、初验款、终验款、质保金 |
| `nodeAmount` | 元。原文只写比例（如 30%）时，按 总额 × 比例 算成元。各节点合计必须等于 `totalAmount`；除不尽时把尾差放在最后一个节点，并在回复里说明 |
| `nodeRatio` | 比例数字，例如 30；原文没写比例可以不传 |
| `plannedDate` | 只有合同写了固定日期时才填 YYYY-MM-DD；依赖开票、验收、签约等条件触发的，填 null |
| `paymentCondition` | 付款条件原文，照抄合同，不要改写 |
| `triggerRule` | 结构化触发规则，见下节 |

## 触发规则 `triggerRule`

```json
{
  "triggerType": "EVENT_OFFSET",
  "triggerEvent": "ACCEPTANCE_PASSED",
  "offsetDays": 30,
  "offsetType": "CALENDAR",
  "logic": "SINGLE"
}
```

- `triggerType`：`EVENT_OFFSET` 某个事件发生后若干天；`FIXED_DATE` 固定日期；`MANUAL` 说不清、需要人工定。
- `triggerEvent`（单一条件时）：
  - `INVOICE_RECEIVED` 收到或开具发票
  - `ACCEPTANCE_PASSED` 验收通过
  - `CONTRACT_SIGNED` 合同签订
  - `DELIVERY_COMPLETED` 交付或到货完成
  - `PAYMENT_RECEIVED` 收付款完成
- `offsetDays`：偏移天数，整数；没有偏移填 0。
- `offsetType`：`CALENDAR` 自然日；`WORKDAY` 工作日。合同写「工作日」才用 `WORKDAY`。
- `logic`：`SINGLE` 单一条件；`MAX` 几个条件都满足、取较晚的（例如「验收通过且收到发票后 15 个工作日内」）；`MIN` 满足其中一个、取较早的。
- `logic` 是 `MAX` 或 `MIN` 时必须填 `conditions`，例如：

```json
{
  "triggerType": "EVENT_OFFSET",
  "logic": "MAX",
  "conditions": [
    { "event": "ACCEPTANCE_PASSED", "offsetDays": 15, "offsetType": "WORKDAY" },
    { "event": "INVOICE_RECEIVED", "offsetDays": 15, "offsetType": "WORKDAY" }
  ]
}
```

## 常见换算例子

- 「合同总价人民币贰佰叁拾万元整（¥2,300,000.00）」→ `totalAmount` = 2300000。大写和小写对不上时以大写为准，并提示用户。
- 「合同签订后 10 日内支付合同总额的 30%」→ 节点金额 = 总额 × 0.3，`plannedDate` = null，触发规则 `CONTRACT_SIGNED` + 10 + `CALENDAR`。
- 「质保期满一年后无息支付 5% 质保金」→ 质保期起算点通常是验收，触发事件选 `ACCEPTANCE_PASSED`，`offsetDays` = 365，并在回复里说明是按验收日起算推断的。
