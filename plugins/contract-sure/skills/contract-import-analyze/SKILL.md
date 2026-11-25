---
name: contract-import-analyze
description: 导入并分析合同：读取用户给的合同文件（电子 PDF、扫描件、图片、文本），扫描件和图片由 DeepSeek 官方 OCR（在插件设置里配置）识别，提取编号、名称、甲乙方、金额、期限和付款/回款节点，指出付款节点、违约、期限、金额等条款里的风险，生成「合同识别核对卡」，用户确认后才入库并归档原件。用户说「导入合同」「识别这份合同」「把合同录进履约系统」「看看这份合同有什么风险」或给出合同文件路径时使用。
---

# 导入并分析合同

把一份合同文件变成履约系统里的一条合同记录，入库前先帮用户把关键字段和条款风险过一遍。

## 什么时候用

- 用户给了合同文件，要导入、录入、识别，或者想知道这份合同有什么风险。
- 用户只要风险分析、不想入库：做到第 4 步给出分析就停，问一句要不要生成核对卡。
- 不适用：
  - Excel 银行流水、发票明细表：用「三流核对」skill（`contract-reconcile-flows`），不要读 Excel 内容。
  - 已经入库的合同查详情：直接用 `contract_query`，`mode="detail"`。

## 开始前

1. **确认文件路径**。用户只说「这份合同」却没给路径时，先问路径，不要猜。
2. **确认格式**。`contract_read_document` 支持 .pdf、.jpg、.jpeg、.png、.txt、.md，单个文件不超过 20MB。
   - Word（.doc、.docx）它读不了。最稳的办法是请用户另存为 PDF 再给你。用户不方便时：先用 `skill` 加载 `office`，再用 `office_convert`（`format="pdf"`）转出 PDF，把转出的 PDF 路径交给 `contract_read_document`；归档原件时仍用用户给的 Word 路径。
3. **账户**。读 PDF、生成核对卡、入库都要已连接履约系统账户；读图片和文本文件不需要。任何工具返回 kind 为 `contract-sure-auth-required` 时：把其中的 message 原样转告用户，然后停下，等用户回复「继续」再接着做。不要重试，不要换别的办法绕过，不要向用户要账号密码。

## 第 1 步：读合同

不管是电子 PDF、扫描件还是图片，都直接调用 `contract_read_document`，`filePath` 填文件路径：

- 电子 PDF：抽取 PDF 自带的文本层，又快又准。
- 扫描件和图片：由 DeepSeek 官方 OCR（在插件设置里配置）识别，版面、表格和金额都能识别得很好，不需要你自己看图。

看返回里的这几项：

| 字段 | 怎么看 |
|---|---|
| `source` | `pdf-text-layer` 是电子 PDF 的文本层；`deepseek-ocr` 是 DeepSeek 官方 OCR 识别的；`plain-text` 是文本文件 |
| `truncated` | 为 true 说明原文超过 12 万字被截断，后面的条款可能没读到，要告诉用户 |
| `pageCount`、`isScanned` | 页数和是否扫描件，写进分析结果的「来源」一行 |
| `text` | 合同正文，直接按它提取字段 |

只有工具报错时才需要别的办法，见文末「常见问题」里的「OCR 报错或没配 Key」。

## 第 2 步：提取字段

按 `references/field-rules.md` 的口径提取，要点：

- 金额一律换算成人民币「元」的纯数字；原文写「万元」要乘以 10000。
- 合同编号优先取文件名里的规范编号，没有再从正文找；找不到就空着并提醒用户，严禁编造。
- 合同类型：我方收钱是销售合同（1），我方付钱是采购合同（2）。看不出来就先按上下文判断，并在结果里提示用户核对。
- 付款/回款节点：比例要换算成金额，各节点金额合计必须等于合同总额；有固定日期才填 `plannedDate`，条件触发的（如「验收合格后 30 日内」）填 null，并写好触发规则。

## 第 3 步：条款风险分析

按 `references/risk-checklist.md` 逐项检查：付款节点、金额与税、期限、违约与赔偿、验收、质保金、发票、解除与争议解决。

- 每条风险写清：严重程度（高/中/低）、条款原文（摘一句即可）、问题在哪、建议怎么办。
- 只写真正发现的问题，没有就写「未发现明显问题」，不要为了凑数硬找。
- 你不是律师：法律判断用「建议请法务确认」的口吻，不下定论。

## 第 4 步：生成核对卡

调用 `contract_stage_draft`，把提取的字段传进去：`contractNo`、`contractName`、`contractType`、`totalAmount`，以及能确定的 `taxRate`、`signDate`、`startDate`、`endDate`、`partyAName`、`partyBName`、`nodes`。`sourceFilePath` 填用户给的原件路径，确认入库时会自动归档原件。签订日期没能确定时 `signDate` 填 null，并用 `signDateNote` 写明签字页识别到了什么，回复里也要请用户对照原件补上。

看返回的 `validation`：编号重复、节点金额合计和总额对不上等提示，要在回复里点出来；`hint` 里提到原件格式不能归档的，也要转告。

然后按下面的格式回复用户，**到这里必须停下**：

```
### 合同要点
| 项目 | 内容 |
（编号、名称、类型、甲方、乙方、总额（元）、税率、签订日期、起止日期、识别来源）

### 付款/回款节点
| 序号 | 节点 | 金额（元） | 比例 | 计划日期或触发条件 |

### 风险提示
1. 【高】……（条款原文）→ 建议……

### 请你核对
- 系统校验提示：……
- 看不清或拿不准的字段：……
请在核对卡里检查无误后点「确认创建并归档原件」，或者回复「确认入库」。
```

这一回合**不要**调用 `contract_confirm_save`。即使用户一开始就说过「直接入库」，也要先让用户看过核对卡：金额和节点要有人过目。

## 第 5 步：用户确认后入库

- 用户在看过核对卡之后明确说「确认」「入库」「没问题」，才调用 `contract_confirm_save`，`draftId` 填第 4 步返回的值。
- 用户已经在核对卡上点了确认按钮，就不要再调用；想确认结果，可以用 `contract_query`（`mode="list"`，`keyword` 填合同编号）查一下。
- 用户要改字段：把改好的完整字段重新调用一次 `contract_stage_draft`，生成新的核对卡，再等用户确认。不要拿旧草稿直接改了入库。
- 入库成功后，把返回的 message 告诉用户，包括合同 ID 和原件是否归档成功。

## 常见问题

| 现象 | 处理 |
|---|---|
| `contract_confirm_save` 报 `DRAFT_NOT_FOUND` | 草稿只在本次运行的内存里，插件重启后会丢。用同样的字段重新调用 `contract_stage_draft`，再请用户确认 |
| 报 `ACCOUNT_SWITCHED`（账户已切换，请重新核对） | 换了账户或服务器。重新调用 `contract_stage_draft`，再请用户确认 |
| 返回 `uploadWarning` | 合同已经建好，只是原件没归档。原样告诉用户，不要重复创建合同 |
| `alreadyConfirmed` 为 true | 这份草稿已经入过库，告诉用户合同 ID，不要再建 |
| 报 `USE_IMPORT_EXCEL` | 用户给的是 Excel 流水，改用「三流核对」skill |
| 报 `UNSUPPORTED_FORMAT` | 格式不支持，按「开始前」第 2 条处理 |
| 校验提示编号重复 | 先问用户：是同一份合同重复导入，还是编号写错了。重复导入就不要入库 |

### OCR 报错或没配 Key

`contract_read_document` 报 `OCR_KEY_MISSING`、`OCR_KEY_INVALID`、`OCR_UNAUTHORIZED`（没配 Key 或 Key 不对），或 `OCR_FAILED`、`OCR_EMPTY`、`OCR_TIMEOUT`、`OCR_ERROR`（接口出错、超时）时：

1. 把报错原文告诉用户。Key 的问题请用户到「设置 → 履约无忧配置」填写或检查 DeepSeek 官方 OCR 的 Key；接口出错可以稍后重试。
2. 用户不想等时，问一句能不能先看图识别。同意后：图片用 `read_image`（`file_path` 填路径）；扫描 PDF 先用 `skill` 加载 `office`，下一步再用 `office_render`（`input` 填路径，`pages` 一次 2～4 页，`dpi` 默认 144），它直接返回页面图片。
3. 看图要求当前模型支持图片：报 `IMAGE_UNSUPPORTED_MODEL` 就请用户换 deepseek-flash 这类模型，或者配好 OCR Key 再读。每张图大约 1024 个图片 token，小字可能看不清：看不清的字段留空、标「待核对」，编号、金额、日期绝不猜，结果里注明「看图识别，请逐项核对」。
4. 两条路都走不通时，明确告诉用户现在读不了这份文件，不要凭文件名或常识编内容。

## 参考文件

| 文件 | 什么时候读 |
|---|---|
| `references/field-rules.md` | 第 2 步提取字段前，尤其是节点金额和触发规则 |
| `references/risk-checklist.md` | 第 3 步做风险分析时 |
