// 公文全流程处理专家 - DSH plugin bridge (gongwen-skill, v2.15.0+)
// (c) 2026 Jose AI (https://www.linhut.cn)
// https://github.com/linhut/gongwen-skill
// Licensed under the MIT License. See the LICENSE file for details.
//
// 分层架构：
// - Python CLI：纯工具层，通过 --config-overrides 接收规则覆盖 JSON
// - DSH 插件 Host：本地配置管理、AI 工作指引和模型工具。
//   * inject: ['tools'] 注册模型工具，参数 schema 由宿主提供给模型。
//   * 可选 systemPrompt 注入工作指引；排版设置由本地配置和 config 工具管理。
//   * call() 透传 Python CLI，保留原有模板与排版引擎。
//
// 技能发现走文件系统（~/.dsh/skills/gongwen-skill/，方式一），插件不再
// 运行时注册 SKILL.md（P2-31：与文件系统技能重复，去掉冗余 API 面）。
//
// 官方依据：DeepSeek Harness Bluebook Developer Guide
//   - Host Services & Events：inject 硬依赖 / ctx.get 可选依赖 / ctx.effect 可逆副作用
//   - Registering Tools：defineTool + ctx.tools.register
// 纯 CLI 用户完全不受影响（不使用 DSH 插件时不会读取 dsh-config.json）

import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, tmpdir } from "node:os";
import { defineTool } from "@deepseek-ai/dsh-tools";


const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// DSH 排版配置文件：工具与公文生成共用，独立于设置界面。
const APP_DATA_DIR = join(homedir(), ".gongwen-skill");
const CONFIG_FILE = join(APP_DATA_DIR, "dsh-config.json");
const DEFAULTS_FILE = join(resolve(__dirname, ".."), "etc", "dsh-config-defaults.json");


// 系统提示段落名（官方约定 plugin:<name>，重复注册会抛错）
const SECTION_NAME = "plugin:gongwen-skill";
const SECTION_ORDER = 100;

// AI 工作指引（模型可见的能力说明；工具 schema 由 defineTool 自动注入）
const GONGWEN_GUIDANCE = `本机公文插件提供25类公文的生成、检查、修复、模板和版式注入。用户要求写通知、报告、请示等完整公文时，默认使用 gongwen(command=draft)：按正确文种生成→格式修复→注入适用版头/版记/页码→检查最终文件，交付实际 .docx 和验证结论。DSH 的 md2docx 自动执行同样完整流程；generate 用于结构化JSON输入并自动修复复检。template只生成空白模板，不能称为完整成品；不得用普通Word写出或仅转换成功替代公文流程。DSH不允许跳过最终验证。
先确定文种，保留用户给定模板、排版要求和真实正文事实；红头、文号、签发人、主送、落款、日期、版记按文种及用户需求提供，缺少影响成品的必要信息时一次性询问，不编造。红头不是所有文种的必需项。需要版式注入时用layout JSON文件传入draft，提供header/footer/page_number，保证注入在复检之前。后续单独修改版头、版记、页码也会重新检查最终文件。
附件说明在正文结语之后、署名日期之前；实际附件正文另行保留。联系附注通过note传递，日期下一行左空二字、中文圆括号，不与正文或版记混排。独立结语按本地风格写“特此通知”不带句号。版记位于整份公文最后，首末粗线、中间细线；发文字号年份用〔〕。不要生成或追加插件AI声明。排版配置读取 ~/.gongwen-skill/dsh-config.json，可用gongwen config查看和调整，不引导进入已停用设置页。生成命令成功不等于成品合格：只在delivery.verified=true时说明最终格式校验P0=0；P1/P2仍须报告，不宣称事实内容和所有发文要素都已审核无误。delivery未通过时报告具体问题并处理，不交付为正式成品。用户已授权生成时持续完成，不反复询问是否继续。保留check、parse、optimize、style-learn、font、header/footer/pagenum等专项能力。`;

// Windows 桌面进程可能未继承 Python 的 PATH，复用已安装的用户版解释器。
function pythonExecutable() {
  if (process.platform !== "win32") return "python";
  const root = join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "Programs", "Python");
  if (existsSync(root)) {
    const versions = readdirSync(root).filter(name => /^Python\d+$/u.test(name)).sort((a, b) => Number(b.slice(6)) - Number(a.slice(6)));
    for (const version of versions) {
      const executable = join(root, version, "python.exe");
      if (existsSync(executable)) return executable;
    }
  }
  return "python";
}
// 定位 gongwen CLI 真实安装根目录
function _resolve_gongwen_root() {
  const projectRoot = resolve(__dirname, "..");
  if (existsSync(join(projectRoot, "gongwen", "__init__.py")) || existsSync(join(projectRoot, "pyproject.toml"))) {
    return projectRoot;
  }
  throw new Error(`\
gongwen-skill plugin bridge 无法定位 gongwen 包 \
(projectRoot=${projectRoot} 未找到 gongwen/__init__.py 或 pyproject.toml). \
请确认插件正确安装在 ~/.dsh/profiles/web/node_modules/gongwen-skill`);
}

// 把命令对象转为 args 数组
function _to_cli_args(args, positionalKeys = []) {
  const cliArgs = [];
  const posSet = new Set(positionalKeys);
  for (const pk of positionalKeys) {
    if (args[pk] !== undefined && args[pk] !== null && args[pk] !== false) {
      cliArgs.push(String(args[pk]));
    }
  }
  for (const [k, v] of Object.entries(args)) {
    if (posSet.has(k)) continue;
    if (v === undefined || v === null || v === false) continue;
    if (v === true) {
      cliArgs.push(`--${k}`);
    } else if (Array.isArray(v)) {
      cliArgs.push(`--${k}`, ...v.map(String));
    } else {
      cliArgs.push(`--${k}`, String(v));
    }
  }
  return cliArgs;
}

// 各命令的位置参数定义（CLI 是唯一业务入口，此处仅转发）
const POSITIONAL_ARGS = {
  template: ["type"],
  parse: ["input"],
  check: ["input"],
  optimize: ["input"],
  generate: ["input"],
  header: ["input"],
  footer: ["input"],
  pagenum: ["input"],
  md2docx: ["input"],
  "optimize-content": ["input"],
  "bold-first": ["input"],
  "fix-common": ["input"],
  "table-signs": ["input"],
  "full-review": ["input"],
  "style-learn": ["input"],
  audit: ["input"],
  review: ["doc_type"],
  "rule-export": ["type"],
  draft: ["input"],
  "rule-import": ["key"],
  font: ["action"],
};

// 支持 --config-overrides 的命令列表
const CONFIG_OVERRIDE_COMMANDS = new Set([
  "template", "check", "optimize", "md2docx", "draft",
]);

// 支持 --doc-type 的命令列表
const DOC_TYPE_COMMANDS = new Set([
  "check", "optimize", "md2docx", "full-review",
]);

// 读取 DSH 配置（每次调用时读取，支持热更新）
function _read_config() {
  try {
    if (!existsSync(CONFIG_FILE)) return null;
    const raw = readFileSync(CONFIG_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// 读取默认配置模板
function _read_defaults() {
  try {
    if (!existsSync(DEFAULTS_FILE)) return {};
    return JSON.parse(readFileSync(DEFAULTS_FILE, "utf-8"));
  } catch {
    return {};
  }
}

// 写入配置文件
function _write_config(config) {
  mkdirSync(APP_DATA_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8");
}

// 深度获取嵌套属性
function _deep_get(obj, path) {
  const keys = path.split(".");
  let cur = obj;
  for (const k of keys) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    cur = cur[k];
  }
  return cur;
}

// 深度设置嵌套属性
function _deep_set(obj, path, value) {
  const keys = path.split(".");
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (cur[keys[i]] === undefined || cur[keys[i]] === null || typeof cur[keys[i]] !== "object") {
      cur[keys[i]] = {};
    }
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
}

// 解析工具入参 extra（JSON 字符串）为对象
// 模型工具的 extra 参数是 JSON 字符串，config 命令需要对象形态，
// 否则 args.action 取不到值，所有动作都会静默退化为 show。
function _parse_extra_object(extra) {
  if (extra && typeof extra === "object") return extra;
  if (typeof extra === "string" && extra.trim() !== "") {
    try {
      const parsed = JSON.parse(extra);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      // 非法 JSON：按空对象处理
    }
  }
  return {};
}

// 处理 config 命令
function _handle_config(args) {
  const action = args.action || "show";

  if (action === "init") {
    if (existsSync(CONFIG_FILE)) {
      return { success: false, error: `配置文件已存在: ${CONFIG_FILE}，如需重置请使用 action: 'reset'` };
    }
    const defaults = _read_defaults();
    const config = {};
    for (const [k, v] of Object.entries(defaults)) {
      if (!k.startsWith("_")) config[k] = v;
    }
    _write_config(config);
    return { success: true, message: `配置已初始化: ${CONFIG_FILE}`, config };
  }

  if (action === "show") {
    const config = _read_config();
    if (!config) {
      return {
        success: true,
        message: `尚未创建配置文件。运行 config --action init 创建默认配置，或使用 --action set 设置单项。`,
        config_file: CONFIG_FILE,
        config: null,
      };
    }
    return { success: true, config, config_file: CONFIG_FILE };
  }

  if (action === "get") {
    const key = args.key;
    if (!key) return { success: false, error: "缺少 key 参数" };
    const config = _read_config() || _read_defaults();
    const value = _deep_get(config, key);
    return { success: true, key, value, config_file: CONFIG_FILE };
  }

  if (action === "set") {
    const key = args.key;
    const value = args.value;
    if (!key) return { success: false, error: "缺少 key 参数" };
    let config = _read_config();
    if (!config) {
      const defaults = _read_defaults();
      config = {};
      for (const [k, v] of Object.entries(defaults)) {
        if (!k.startsWith("_")) config[k] = v;
      }
    }
    let parsed = value;
    if (typeof value === "string") {
      if (value === "true") parsed = true;
      else if (value === "false") parsed = false;
      else if (/^-?\d+(\.\d+)?$/.test(value)) parsed = parseFloat(value);
      else {
        try {
          const obj = JSON.parse(value);
          parsed = obj;
        } catch {
          parsed = value;
        }
      }
    }
    _deep_set(config, key, parsed);
    _write_config(config);
    return { success: true, message: `已设置 ${key} = ${JSON.stringify(parsed)}`, config };
  }

  if (action === "reset") {
    const defaults = _read_defaults();
    const config = {};
    for (const [k, v] of Object.entries(defaults)) {
      if (!k.startsWith("_")) config[k] = v;
    }
    _write_config(config);
    return { success: true, message: `配置已重置为默认值: ${CONFIG_FILE}`, config };
  }

  return { success: false, error: `未知的 config action: ${action}` };
}

// 运行一条 gongwen CLI 命令（call() 与模型工具 execute 共用）
// @param command - gongwen 命令名
// @param args - CLI 参数对象（键名即参数名，含位置参数）
// @param options - { cwd?, signal? }
async function runCli(command, args = {}, options = {}) {
  let projectRoot;
  try {
    projectRoot = _resolve_gongwen_root();
  } catch (err) {
    return { success: false, error: err.message };
  }

  const { cwd = projectRoot, signal } = options;
  const rest = { ...args };

  // 读取 DSH 配置并注入 --config-overrides（仅支持的命令）
  const config = _read_config();
  let configOverrides = null;
  if (config && CONFIG_OVERRIDE_COMMANDS.has(command)) {
    configOverrides = {};
    for (const [k, v] of Object.entries(config)) {
      if (!k.startsWith("_") && k !== "default_doc_type") {
        configOverrides[k] = v;
      }
    }
    if (Object.keys(configOverrides).length === 0) {
      configOverrides = null;
    }
  }

  // 合并用户传的 overrides（用户值优先级更高）
  if (configOverrides && rest["config-overrides"]) {
    try {
      const userOverrides = JSON.parse(rest["config-overrides"]);
      const merge = (base, patch) => {
        const merged = { ...base };
        for (const [key, value] of Object.entries(patch)) {
          merged[key] = value && typeof value === "object" && !Array.isArray(value)
            ? merge(base?.[key] || {}, value) : value;
        }
        return merged;
      };
      configOverrides = merge(configOverrides, userOverrides);
    } catch {
      return { success: false, error: "config-overrides 必须是有效的 JSON 对象。" };
    }
  } else if (rest["config-overrides"]) {
    configOverrides = null;
  }

  if (configOverrides) {
    rest["config-overrides"] = JSON.stringify(configOverrides);
  }

  // 支持 default_doc_type
  if (command === "draft" && config?.default_doc_type) rest["default-doc-type"] = config.default_doc_type;
  if (config?.default_doc_type && DOC_TYPE_COMMANDS.has(command) && !rest["doc-type"] && !rest["t"]) {
    rest["doc-type"] = config.default_doc_type;
  }

  const positionalKeys = POSITIONAL_ARGS[command] || [];
  const cliArgs = ["-m", "gongwen", command, ..._to_cli_args(rest, positionalKeys)];

  return await new Promise((resolvePromise) => {
    const child = spawn(pythonExecutable(), cliArgs, {
      cwd,
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
      windowsHide: true,
    });
    const abort = () => child.kill();
    signal?.addEventListener("abort", abort, { once: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString("utf-8")));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf-8")));
    child.on("error", (err) => {
      signal?.removeEventListener("abort", abort);
      resolvePromise({
        success: false,
        error: `python spawn failed: ${err.message}`,
        cli: `python ${cliArgs.join(" ")}`,
        cwd,
      });
    });
    child.on("close", (code) => {
      signal?.removeEventListener("abort", abort);
      let data;
      try { data = JSON.parse(stdout.trim()); } catch { /* CLI may return plain text. */ }
      resolvePromise({ success: code === 0, exit_code: code,
        ...(data !== undefined ? { data } : { output: stdout.trim() }),
        stderr: stderr.trim(), ...(code === 0 ? {} : { cli: `python ${cliArgs.join(" ")}`, cwd }),
      });
    });
  });
}


// DSH 的生成入口统一完成最终验证；底层 CLI 仍保留单步能力。
function deliveryResult(result, command, cwd) {
  const data = result.data;
  const output = typeof data?.output === "string" ? resolve(cwd || _resolve_gongwen_root(), data.output) : null;
  const exists = typeof output === "string" && existsSync(output);
  const verify = command === "draft" ? data?.optimize : data;
  const passed = result.success && exists && verify?.verify_executed === true &&
    verify?.verified === true && verify?.verify_passed === true && verify?.verify_p0 === 0;
  const stage = passed ? "verified" : !exists ? "generation_failed" :
    verify?.verify_executed === true && Number(verify?.verify_p0) > 0 ? "needs_revision" : "verification_failed";
  return { ...result, success: Boolean(passed), delivery: {
    stage, output: exists ? output : null, verified: Boolean(passed),
    issues: { P0: verify?.verify_p0 ?? null, P1: verify?.verify_p1 ?? null, P2: verify?.verify_p2 ?? null },
    message: passed ? "最终文件格式检查通过（P0=0）；内容事实及适用发文要素仍需人工确认。" :
      "尚未达到成品交付条件，请查看生成或最终检查错误，不得宣称验证通过。",
  } };
}
async function runDelivery(command, args = {}, options = {}) {
  args = { ...args };
  if (["draft", "md2docx", "generate", "optimize", "check"].includes(command) && args.template) {
    args["doc-type"] = args.template;
    delete args.template;
  }
  if (["draft", "md2docx", "generate", "optimize"].includes(command) &&
      (args["no-verify"] || args.verify === false)) {
    return { success: false, error: "DSH 公文交付流程必须验证最终文件，不允许跳过检查。" };
  }
  if (command === "draft" || command === "md2docx") {
    const result = await runCli("draft", { ...args, verify: true, json: true, "no-ai-declaration": true }, options);
    return deliveryResult(result, "draft", options.cwd);
  }
  if (command === "generate") {
    const temporary = mkdtempSync(join(tmpdir(), "gongwen-delivery-"));
    try {
      const interim = join(temporary, "generated.docx");
      const generated = await runCli("generate", { input: args.input, output: interim }, options);
      if (!generated.success || !existsSync(interim)) return { ...generated, success: false, delivery: { stage: "generation_failed", verified: false } };
      const output = resolve(options.cwd || _resolve_gongwen_root(), args.output || `${String(args.input).split(/[\\/]/).at(-1).replace(/\.json$/i, "")}-成品.docx`);
      const result = await runCli("optimize", { input: interim, output, apply: true, verify: true, json: true, "remove-ai-declaration": true,
        ...(args["doc-type"] ? { "doc-type": args["doc-type"] } : {}),
        ...(args.layout ? { layout: args.layout } : {}),
        ...(args["config-overrides"] ? { "config-overrides": args["config-overrides"] } : {}),
      }, options);
      return deliveryResult(result, "optimize", options.cwd);
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  }
  if (command === "optimize") {
    const result = await runCli(command, { ...args, verify: true, json: true, "remove-ai-declaration": true }, options);
    if (!args.apply) return { ...result, delivery: { stage: "preview", verified: false, message: "仅预览；未生成正式成品。" } };
    return deliveryResult(result, command, options.cwd);
  }
  const postLayout = ["header", "footer", "pagenum", "bold-first", "fix-common"].includes(command);
  const stepArgs = { ...args };
  if (postLayout) { delete stepArgs["doc-type"]; delete stepArgs.t; delete stepArgs["config-overrides"]; }
  const result = await runCli(command, stepArgs, options);
  if (command === "template") return { ...result, delivery: { stage: "template", verified: false, message: "这是空白模板，不是完整公文成品。" } };
  if (postLayout && result.success) {
    const output = resolve(options.cwd || _resolve_gongwen_root(), args.output || args.input);
    const checked = await runCli("check", { input: output, json: true,
      ...(args["doc-type"] ? { "doc-type": args["doc-type"] } : {}),
    }, options);
    const issues = Array.isArray(checked.data) ? checked.data : null;
    const counts = issues && Object.fromEntries(["P0", "P1", "P2"].map(level => [level, issues.filter(issue => issue.severity === level).length]));
    const passed = result.success && existsSync(output) && checked.success && issues !== null && counts.P0 === 0;
    return { ...result, success: Boolean(passed), delivery: { stage: passed ? "verified" : issues ? "needs_revision" : "verification_failed",
      output, verified: Boolean(passed), issues: counts, check: checked } };
  }
  return result;
}

// Agent 预设安装：把插件包内 presets/（preset.yml + agent.cordis.yml）同步到
// ~/.dsh/.agent-presets/gongwen-skill/，使 DSH Web 新建会话可选「公文全流程处理专家」预设。
// 仅补充缺失的预设文件，保留用户已调整的写作和排版预设。
function ensurePresetInstalled() {
  try {
    const userPresetDir = join(homedir(), ".dsh", ".agent-presets", "gongwen-skill");
    mkdirSync(userPresetDir, { recursive: true });
    const pluginPresets = join(resolve(__dirname, ".."), "presets");
    const presetYml = join(pluginPresets, "preset.yml");
    const agentYml = join(pluginPresets, "agent.cordis.yml");
    if (existsSync(presetYml) && !existsSync(join(userPresetDir, "preset.yml"))) {
      copyFileSync(presetYml, join(userPresetDir, "preset.yml"));
    }
    if (existsSync(agentYml) && !existsSync(join(userPresetDir, "agent.cordis.yml"))) {
      copyFileSync(agentYml, join(userPresetDir, "agent.cordis.yml"));
    }
  } catch {
    // 预设安装失败不阻塞插件其余能力
  }
}

// 模型工具参数 → CLI 参数对象（camel/snake → CLI kebab 映射）
function toolArgsToCli(args) {
  const out = {};
  // extra：JSON 对象字符串（模型按 description 构造），解析失败则忽略
  if (typeof args.extra === "string" && args.extra.trim() !== "") {
    try {
      const parsed = JSON.parse(args.extra);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        Object.assign(out, parsed);
      }
    } catch {
      // 非 JSON 忽略（execute 层会报告）
    }
  }
  const map = {
    input: "input",
    output: "output",
    docType: "doc-type",
    template: "template",
    style: "style",
    mode: "mode",
    changes: "changes",
    apply: "apply",
    json: "json",
    note: "note",
  };
  for (const [key, cliKey] of Object.entries(map)) {
    const v = args[key];
    if (v !== undefined && v !== null) out[cliKey] = v;
  }
  return out;
}

// 工具输出渲染（模型可见）
function renderToolResult(_args, value) {
  if (typeof value === "string") {
    return [{ type: "text", text: value }];
  }
  return [{ type: "text", text: JSON.stringify(value, null, 2) }];
}

// 注册官方模型工具（defineTool + ctx.tools.register，schema 自动流入系统提示词）
function registerGongwenTool(ctx) {
  ctx.tools.register(defineTool({
    name: "gongwen",
    description:
      "完整公文默认 draft：生成、格式修复、适用版式注入、最终检查后交付DOCX；md2docx在DSH中同样执行完整流程。generate为结构化生成并复检，template仅空白模板。仅delivery.verified=true表示最终格式校验通过，需报告P1/P2。其余命令check/parse/optimize/style-learn等供专项处理。",
    parameters: {
      command: {
        type: "string",
        required: true,
        description:
          "默认draft完成公文生成及最终验证；还支持check、parse、optimize、generate、template、header、footer、pagenum、style-learn、list-types等。",
      },
      input: { type: "string", description: "输入文件路径（多数命令的位置参数）" },
      output: { type: "string", description: "输出文件路径（-o / --output）" },
      docType: {
        type: "string",
        description: "公文类型（--doc-type / -t）：notice、request、report、letter、meeting-minutes 等；运行 list-types 查看全部",
      },
      note: { type: "string", description: "联系附注，如联系人及联系电话；独立编排在成文日期下一行，左空二字并用中文圆括号包裹。" },
      template: { type: "string", description: "样式模板名（--template，style-learn 学到的命名模板）" },
      style: { type: "string", description: "内容优化风格（--style）" },
      mode: { type: "string", description: "修订模式（--mode），如 tracked" },
      changes: { type: "string", description: "内容变更 JSON 文件路径（--changes）" },
      apply: { type: "boolean", description: "直接应用、跳过确认（--apply / -y）" },
      json: { type: "boolean", description: "输出 JSON（--json）" },
      extra: {
        type: "string",
        description:
          "其余 CLI 参数透传，JSON 对象字符串：键为参数名（不含 -- 前缀），值为字符串、数字或布尔。例如 {\"doc-type\":\"notice\",\"style\":\"庄重严谨\"}。",
      },
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: renderToolResult,
    },
    async execute(args, exec) {
      if (!args.command) {
        return { success: false, error: "缺少必填参数：command" };
      }
      // config 命令由 DSH 侧直接处理
      if (args.command === "config") {
        return _handle_config(_parse_extra_object(args.extra));
      }
      return await runDelivery(args.command, toolArgsToCli(args), { signal: exec?.signal });
    },
  }));
}

export const name = "gongwen-skill";
export const description =
  "公文全流程处理专家（gongwen-skill）—— 中文公文 GB/T 9704 格式检查/修复/内容优化/模板生成/版式注入";

// 硬依赖仅为 tools；systemPrompt 通过 ctx.get 可选读取。
export const inject = ["tools"];

// apply() — Cordis 生命周期管理（所有注册均为可逆副作用）
export function apply(ctx) {
  const disposers = [];

  // 软探测 gongwen 根目录：找不到仅记录，不阻塞插件自身注册
  // （工具/设置/skill 注册不依赖项目根；call/runCli 才需要）
  let projectRoot = null;
  try {
    projectRoot = _resolve_gongwen_root();
  } catch {
    ctx.logger?.warn?.("gongwen-skill: gongwen 包未定位，CLI 调用将在执行时失败");
  }

  try {
    // 1. 注册官方模型工具（inject 硬依赖，fiber dispose 自动注销）
    try {
      registerGongwenTool(ctx);
    } catch (e) {
      ctx.logger?.warn?.(`gongwen-skill: tool registration failed: ${e.message}`);
    }

    // 2. 注入 AI 工作指引（可选服务 ctx.systemPrompt）
    const sp = ctx.get("systemPrompt");
    if (sp?.section) {
      try {
        const d = sp.section({
          name: SECTION_NAME,
          order: SECTION_ORDER,
          text: GONGWEN_GUIDANCE,
        });
        if (typeof d === "function") disposers.push(d);
      } catch (e) {
        ctx.logger?.warn?.(`gongwen-skill: system prompt registration failed: ${e.message}`);
      }
    }

    // 排版设置仍由本地 dsh-config.json 和 gongwen config 工具管理。
    // 4. 安装 Agent 预设
    //    让 DSH 新建会话可选「公文全流程处理专家」；失败不影响插件其余能力）
    ensurePresetInstalled();

    ctx.logger?.info?.(`gongwen-skill plugin loaded${projectRoot ? ` (projectRoot=${projectRoot})` : "（gongwen 包未定位）"}`);
  } catch (err) {
    ctx.logger?.error?.(`gongwen-skill plugin apply failed: ${err.message}`);
  }

  // 注册全部 disposer 到 ctx.effect（确保可逆）
  ctx.effect(() => {
    return () => {
      for (const d of disposers) {
        try {
          if (typeof d === "function") d();
        } catch {}
      }
    };
  }, "gongwen-skill: apply cleanup");
}

// call() — 透传 Python CLI（保留向后兼容）
export async function call(ctx, args) {
  const { command, ...rest } = args;
  if (!command) {
    return { success: false, error: "missing required field: command" };
  }

  // config 命令由 DSH 侧直接处理
  if (command === "config") {
    return _handle_config(_parse_extra_object(rest));
  }

  return await runDelivery(command, rest, { cwd: ctx?.cwd });
}
