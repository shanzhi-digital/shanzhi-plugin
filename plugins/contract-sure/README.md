# 履约无忧（@local/contract-sure）

面向 DeepSeek Harness（DSH `0.2.2-rc.1`）与小智办公的智能合同履约助手插件，零第三方运行时 npm 依赖，连接「履约无忧」Spring Boot 后端提供合同文档识别核对、三流对账、履约看板分析与原件预览能力。

## 核心能力

1. **电子 PDF 零成本提取 + DeepSeek OCR 扫描件回退（`contract_read_document`）**
   - `.txt` / `.md` 直接读取；
   - 电子版 `.pdf` 优先调用后端 PDFBox 接口提取文本层（零 OCR 费用）；
   - 扫描件 `.pdf` 与 `.jpg` / `.jpeg` / `.png` / `.webp` 自动回退至 DeepSeek 官方 OCR 接口（支持 OpenAI 兼容视觉接口回退）。
2. **交互式「合同识别核对卡」（`contract_stage_draft` + `contract_confirm_save`）**
   - 提取合同编号、名称、甲乙方户名、总金额、签订日期、付款节点与结构化 `triggerRule` 后，先经后端 `POST /contracts/validate` 校验编号重复与节点总额一致性；
   - 在对话末尾渲染可编辑的「合同识别核对卡」，用户核对校验提示后一键确认入库并自动归档合同原件。
3. **合同查询与看板分析（`contract_query` + `contract_dashboard`）**
   - 列表与 12 个月履约趋势返回规范的中文 `columns` + `rows`，可直接联动 `@local/datahub-echarts` 的 `query_result_chart` 展示交互表格、柱状图/折线图并导出 CSV/XLSX；
   - 详情模式自动呈现「合同与票据原件」列表，点击「查看原件」后经后端鉴权缓存至本地并在右侧内置阅读器预览。
4. **三流确定性业务操作（`contract_manage_flow`）**
   - 批量导入银行流水/发票 Excel（自动触发全局对账与节点分配）、查询未匹配流水、人工匹配流水到合同/节点、上传节点三流证明材料（发票/收付款单/验收材料）及人工指定节点应付款日期。
5. **配置与鉴权管理（设置页 + `contract_config` 工具）**
   - Web 设置页提供独立平级菜单「履约无忧配置」（`settings.section`），支持后端地址、令牌、DeepSeek OCR 配置、测试连接与「账号密码一键换取 90 天长期令牌」；
   - 同步持久化至 `~/.contract-sure/dsh-config.json` 与宿主 `settings`（`contract-sure` 命名空间），纯 CLI 模式下可通过 `contract_config` 完成全部配置。

## 配置说明

配置文件路径：`~/.contract-sure/dsh-config.json`

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `serverUrl` | `http://localhost:8081/api/v1` | 履约无忧后端 API 基础地址 |
| `apiToken` | `""` | 长期插件访问令牌（可通过账号密码一键换取） |
| `ocrApiUrl` | `https://api.deepseek.com/v1/tools/ocr` | DeepSeek OCR 接口地址 |
| `ocrApiKey` | `""` | DeepSeek API Key（未配置时自动回退环境变量 `DEEPSEEK_API_KEY`） |

## 工具清单

| 工具名 | 用途 |
| --- | --- |
| `contract_config` | 查看/修改/测试配置，或通过用户名密码换取长期令牌 |
| `contract_read_document` | 读取合同 PDF/图片/文本，自动区分电子 PDF 与扫描件 OCR |
| `contract_stage_draft` | 校验提取草稿并渲染交互式「合同识别核对卡」 |
| `contract_confirm_save` | 确认创建合同并自动归档原件 |
| `contract_query` | 查询合同列表（表格行）或合同详情与原件清单 |
| `contract_dashboard` | 查询履约看板核心 KPI 与 12 个月趋势数据 |
| `contract_manage_flow` | 批量导入 Excel 流水、查未匹配、人工匹配、传节点凭证、指定付款日 |

## 本地测试

在插件目录执行：

```bash
node --test doc-reader.test.js tools.test.js client.test.js
node --check client.js
```

## 许可证

MIT License，详见 [LICENSE](LICENSE)。
