import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApiError, defaultApiClient, safeErrorMessage } from './api-client.js';
import { createWorkspacePaths } from './workspace-paths.js';
import { createAccountManager } from './accounts.js';
import { createBinaryManager } from './binary-manager.js';
import { createCaptureManager } from './capture-manager.js';
import { createTranscriberManager } from './transcriber-manager.js';
import { createAudioImporter } from './audio-importer.js';
import { buildFeishuTaskPayload, createMeetingStore } from './meeting-store.js';
import { createVoiceprintManager } from './voiceprints.js';
import { createKnowledgeSync } from './knowledge-sync.js';
import { createPipelineRunner } from './pipeline-runner.js';
import { createPlaybackServer } from './playback-server.js';
import { registerEchoMindRemote } from './remote-service.js';
import { toToolOutput } from './tool-output.js';
import { ECHOMIND_PROMPT, PROMPT_SECTION_NAME, PROMPT_SECTION_ORDER } from './prompts.js';
import {
  MINUTES_CARD_KIND,
  MINUTES_PRESENTED_RECORD_TYPE,
  RECORDING_CARD_KIND,
  RECORDING_EVENT_RECORD_TYPE,
  TODO_DRAFT_KIND,
  TODO_DRAFT_RECORD_TYPE,
  TODO_PUSHED_RECORD_TYPE,
} from './event-projection.js';

// 动态按需加载可选 DSH 宿主包，保证独立 Node 单测在零三方依赖下可直接执行。
let hostAppendPluginRecord = null;
let hostTypert = null;
let hostDshHomePath = null;

try {
  const sessionMod = await import('@deepseek-ai/dsh-session');
  hostAppendPluginRecord = sessionMod.appendPluginRecord || null;
} catch {
  // Running outside DSH host.
}

try {
  const typertMod = await import('@deepseek-ai/dsh-typert-protocol');
  if (typertMod.TypertRemoteService && typertMod.Remote && typertMod.RemoteError) {
    hostTypert = {
      TypertRemoteService: typertMod.TypertRemoteService,
      Remote: typertMod.Remote,
      RemoteError: typertMod.RemoteError,
    };
  }
} catch {
  // Running outside DSH host.
}

try {
  const pathsMod = await import('@deepseek-ai/dsh-home-paths');
  hostDshHomePath = pathsMod.dshHomePath || null;
} catch {
  // Running outside DSH host.
}

export const name = '@local/echomind';
export const description =
  'EchoMind 智能会议纪要助手（双轨实时录音、本机离线转写、声纹识别、纪要与待办核对推飞书、音频回放与知识库同步）';
export const inject = ['tools'];

export const SKILL_PROVIDER_NAME = '@local/echomind';
export const BUNDLED_SKILL_NAMES = Object.freeze([
  'echomind-live-meeting',
  'echomind-review-and-push',
  'echomind-search-and-trace',
  'echomind-import-audio',
  'echomind-cross-system-followup',
]);
export const SKILLS_DIR = fileURLToPath(new URL('./skills/', import.meta.url));
const BUNDLED_SKILL_RANK = 600;
const MAX_STAGED_TODO_DRAFTS = 100;

const SOURCE_LABELS = Object.freeze({
  tencent: '腾讯会议',
  feishu: '飞书会议',
  zoom: 'Zoom',
  offline: '线下会议',
  other: '其他',
});

const STATUS_LABELS = Object.freeze({
  recording: '录音中',
  transcribing: '转写中',
  review: '待确认待办',
  ready: '已生成',
  pushed: '已推送飞书',
  failed: '处理失败',
});

const textRender = (_args, value) => [{ type: 'text', text: JSON.stringify(value) }];

export function parseSkillFile(raw, path) {
  const block = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw);
  if (!block) throw new Error(`${path} 缺少 frontmatter`);
  const meta = {};
  for (const line of block[1].split(/\r?\n/u)) {
    const pair = /^([A-Za-z][\w-]*):\s*(.*)$/u.exec(line);
    if (pair) meta[pair[1]] = pair[2].trim().replace(/^(['"])(.*)\1$/u, '$2');
  }
  if (!meta.name) throw new Error(`${path} 缺少 name`);
  if (!meta.description) throw new Error(`${path} 缺少 description`);
  return { name: meta.name, description: meta.description, content: raw.slice(block[0].length).trim() };
}

export function createSkillProvider({
  providerName = SKILL_PROVIDER_NAME,
  skillsDir = SKILLS_DIR,
  skillNames = BUNDLED_SKILL_NAMES,
  control,
  logger,
} = {}) {
  const warned = new Map();
  const warnOnce = (skillName, error) => {
    const text = String(error?.message ?? error);
    if (warned.get(skillName) === text) return;
    warned.set(skillName, text);
    try {
      logger?.warn?.(`${providerName}: skill "${skillName}" 不可用：${text}`);
    } catch {
      // Ignore logger errors.
    }
  };

  async function readSkill(skillName, signal) {
    const directory = join(skillsDir, skillName);
    const path = join(directory, 'SKILL.md');
    let raw;
    try {
      raw = await readFile(path, { encoding: 'utf8', signal });
    } catch (error) {
      if (signal?.aborted) throw error;
      warnOnce(skillName, error);
      return { ok: false, error, persistent: error?.code === 'ENOENT' || error?.code === 'ENOTDIR' };
    }
    try {
      const parsed = parseSkillFile(raw, path);
      if (parsed.name !== skillName) {
        throw new Error(`${path} 的 name 是 "${parsed.name}"，应与目录名 "${skillName}" 一致`);
      }
      warned.delete(skillName);
      return { ok: true, ...parsed, directory, path };
    } catch (error) {
      warnOnce(skillName, error);
      return { ok: false, error, persistent: true };
    }
  }

  return {
    name: providerName,
    async list(options = {}) {
      const reads = await Promise.all(skillNames.map((skillName) => readSkill(skillName, options.signal)));
      const candidates = reads
        .filter((r) => r.ok)
        .map((r) => ({
          name: r.name,
          description: r.description,
          invocation: { modelInvocable: true, userInvocable: true },
          provider: providerName,
          source: 'bundled',
          rank: BUNDLED_SKILL_RANK,
          path: r.path,
          resourceBase: { kind: 'directory', path: r.directory.split(sep).join('/') },
          locator: r.path,
        }));
      return { candidates, complete: reads.every((r) => r.ok || r.persistent) };
    },
    async get(candidate, options = {}) {
      const read = await readSkill(candidate.name, options.signal);
      if (!read.ok) {
        if (!read.persistent) throw read.error;
        control?.invalidate?.();
        return undefined;
      }
      const { rank: _rank, locator: _locator, ...summary } = candidate;
      return { ...summary, content: read.content };
    },
  };
}

function getHostService(ctx, svcName) {
  if (!ctx) return undefined;
  if (typeof ctx.get === 'function') return ctx.get(svcName);
  return ctx[svcName];
}

function resolveSessionContext(ctx, sessionId, callId) {
  const sessions = getHostService(ctx, 'sessions');
  if (!sessions || !sessionId) return { session: null, turn: null, callSeq: null, workspaceDir: '' };
  const session = sessions.get?.(sessionId) || null;
  const workspaceDir =
    typeof session?.cwd === 'string' && session.cwd.trim()
      ? session.cwd.trim()
      : (typeof session?.workspace === 'string' && session.workspace.trim() ? session.workspace.trim() : '');
  if (!session || typeof session.snapshotEvents !== 'function') {
    return { session, turn: null, callSeq: null, workspaceDir };
  }
  const events = session.snapshotEvents();
  const callEvent = callId ? events.findLast?.((ev) => ev.type === 'tool/call' && ev.data?.callId === callId) : null;
  const turn =
    callEvent?.data?.turn ??
    events.findLast?.((ev) => ev.type === 'turn/start')?.data?.turn ??
    null;
  return { session, turn, callSeq: callEvent?.seq ?? null, workspaceDir };
}

function emitPluginRecord(appendFn, session, type, data) {
  if (!appendFn || !session) return;
  try {
    appendFn(session, type, data);
  } catch {
    // Non-fatal: tool JSON fallback still renders client cards.
  }
}

function formatDurationMinutes(durationMs) {
  const ms = Number(durationMs) || 0;
  if (ms <= 0) return '0 分钟';
  const mins = Math.max(1, Math.round(ms / 60_000));
  if (mins < 60) return `${mins} 分钟`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h} 小时 ${m} 分钟` : `${h} 小时`;
}

function formatMeetingListRows(meetings = []) {
  const columns = ['会议ID', '会议标题', '形式', '开始时间', '时长', '状态', '待办数', '已入知识库'];
  const rows = meetings.map((m) => ({
    会议ID: m.id,
    会议标题: m.title || '未命名会议',
    形式: SOURCE_LABELS[m.source] || m.source || '其他',
    开始时间: m.startedAt || '',
    时长: formatDurationMinutes(m.durationMs),
    状态: STATUS_LABELS[m.status] || m.status || '',
    待办数: Array.isArray(m.todos) ? m.todos.length : 0,
    已入知识库: m.knowledge?.off ? '已关闭' : (m.knowledge?.sentHash ? '已同步' : '待同步'),
  }));
  return { columns, rows };
}

export function setupEchoMind(ctx, deps = {}) {
  const apiClient = deps.apiClient || defaultApiClient;
  const appendPluginRecord = deps.appendPluginRecord ?? hostAppendPluginRecord;
  const dshHomePath = deps.dshHomePath ?? hostDshHomePath;
  const now = deps.now || (() => Date.now());
  const disposers = [];
  const stagedTodoDrafts = new Map();

  let currentConfigCache = { recordingsDir: '', binaryMirrorUrl: '', modelMirrorUrl: '' };

  const paths = createWorkspacePaths({
    dataRoot: deps.dataRoot,
    dshHomePath,
    getConfiguredRecordingsDir: () => currentConfigCache.recordingsDir,
  });

  const configPath = deps.configPath || paths.configPath;
  const credentialsPath = deps.credentialsPath || paths.credentialsPath;

  const accounts = createAccountManager(ctx, {
    apiClient,
    configPath,
    credentialsPath,
    credentialStore: deps.credentialStore,
    callbackHost: deps.callbackHost,
    callbackPort: deps.callbackPort,
    hostname: deps.hostname,
    now,
    onAccountChange: () => {
      void refreshConfigCache();
    },
  });
  disposers.push(() => accounts.dispose());

  async function refreshConfigCache() {
    try {
      const state = await accounts.getState();
      currentConfigCache = {
        recordingsDir: state.recordingsDir || '',
        binaryMirrorUrl: state.binaryMirrorUrl || '',
        modelMirrorUrl: state.modelMirrorUrl || '',
      };
    } catch {
      // Keep previous cache.
    }
  }
  void refreshConfigCache();

  const binaryManager =
    deps.binaryManager ||
    createBinaryManager({
      paths,
      getMirrorUrl: () => currentConfigCache.binaryMirrorUrl,
      manifestPath: deps.manifestPath,
      platform: deps.platform,
      arch: deps.arch,
      envBinDir: deps.envBinDir,
      extraSearchDirs: deps.extraSearchDirs,
      downloader: deps.downloader,
    });

  const meetingStore = deps.meetingStore || createMeetingStore({ paths, now });

  const transcriberManager =
    deps.transcriberManager ||
    createTranscriberManager({
      binaryManager,
      paths,
      getModelMirrorUrl: () => currentConfigCache.modelMirrorUrl,
      spawnImpl: deps.spawnImpl,
    });
  disposers.push(() => transcriberManager.dispose());

  const voiceprintManager =
    deps.voiceprintManager ||
    createVoiceprintManager({
      accounts,
      meetingStore,
      transcriberManager,
      paths,
      apiClient,
      enableBackgroundTimer: deps.enableBackgroundTimers !== false,
    });
  disposers.push(() => voiceprintManager.dispose());

  const knowledgeSync =
    deps.knowledgeSync ||
    createKnowledgeSync({
      accounts,
      meetingStore,
      apiClient,
      enableBackgroundTimer: deps.enableBackgroundTimers !== false,
    });
  disposers.push(() => knowledgeSync.dispose());

  const pipelineRunner =
    deps.pipelineRunner ||
    createPipelineRunner({
      accounts,
      meetingStore,
      transcriberManager,
      voiceprintManager,
      knowledgeSync,
      paths,
      apiClient,
      createProvider: deps.createProvider,
      now,
    });

  const audioImporter =
    deps.audioImporter ||
    createAudioImporter({
      paths,
      platform: deps.platform,
      spawnImpl: deps.spawnImpl,
      now,
    });

  const captureManager =
    deps.captureManager ||
    createCaptureManager({
      binaryManager,
      paths,
      platform: deps.platform,
      spawnImpl: deps.spawnImpl,
      now,
      onRecordingStarted: (snap) => {
        meetingStore.ensureMeetingSkeleton({
          meetingId: snap.meetingId,
          outDir: snap.outDir,
          title: snap.title,
          source: snap.source,
          startedAt: snap.startedAt,
        });
      },
      onRecordingStopped: (info) => {
        meetingStore.ensureMeetingSkeleton({
          meetingId: info.meetingId,
          outDir: info.outDir,
          title: info.title,
          source: info.source,
          startedAt: info.startedAt,
          durationMs: info.durationMs,
        });
        meetingStore.patchMeeting(info.meetingId, {
          durationMs: info.durationMs || 0,
          status: 'transcribing',
        });
        // 录完自动排队跑转写 → 声纹 → 日历 → 纪要。
        void pipelineRunner.start(info.meetingId).catch(() => {});
      },
    });
  disposers.push(() => {
    void captureManager.dispose();
  });

  const playbackServer = deps.playbackServer || createPlaybackServer({ paths });
  disposers.push(() => playbackServer.dispose());

  function storeTodoDraft(entry) {
    if (stagedTodoDrafts.size >= MAX_STAGED_TODO_DRAFTS) {
      const oldest = stagedTodoDrafts.keys().next().value;
      if (oldest !== undefined) stagedTodoDrafts.delete(oldest);
    }
    stagedTodoDrafts.set(entry.draftId, entry);
  }

  /**
   * 仅通过前端 RPC 调用的「确认并推送飞书任务」：
   * 逐条顺序创建，遇首错立即停止并保留已成功条目的 feishuTaskId，防止重试产生重复任务。
   */
  async function confirmPushTodos({ draftId, editedTodos, signal }) {
    const draft = stagedTodoDrafts.get(draftId);
    if (!draft) {
      throw new ApiError('该待办推送草稿已失效或已处理，请重新发起核对。', { code: 'DRAFT_NOT_FOUND' });
    }
    if (draft.status === 'pushed') {
      return { draftId, status: 'pushed', pushed: draft.pushed || [], failed: null };
    }
    const meeting = meetingStore.getMeeting(draft.meetingId, { includeTranscript: true });
    if (!meeting) {
      throw new ApiError('找不到对应的会议记录。', { code: 'NOT_FOUND' });
    }

    const active = await accounts.getActiveBackend();
    if (!active.ok) {
      throw new ApiError(active.authRequired.message, { code: 'UNAUTHORIZED' });
    }
    if (draft.accountId && draft.accountId !== active.account.id) {
      throw new ApiError('当前账户已切换，请重新核对待办后再推送。', { code: 'ACCOUNT_SWITCHED' });
    }

    const sourceList = Array.isArray(editedTodos) && editedTodos.length > 0 ? editedTodos : draft.todos;
    const selected = sourceList.filter((item) => item && item.selected !== false && String(item.title || '').trim());
    if (selected.length === 0) {
      throw new ApiError('请至少勾选一条有效待办再推送。', { code: 'INVALID_REQUEST' });
    }

    const people = await pipelineRunner.loadDirectory(false, signal);
    const nameOf = (pid) => people.find((p) => p.id === pid)?.name;
    const meOpenId = active.account.openId;

    const pushed = [];
    let failed = null;
    const meetingTodos = Array.isArray(meeting.todos) ? [...meeting.todos] : [];

    for (const item of selected) {
      // 已经推送过的条目直接跳过，保证失败断点重试幂等。
      const existing = meetingTodos.find((t) => t.id === item.id);
      if (existing?.feishuTaskId) {
        pushed.push({ id: existing.id, title: existing.title, guid: existing.feishuTaskId, url: existing.feishuTaskUrl || '' });
        continue;
      }

      const todoObj = {
        id: item.id || `${meeting.id}.manual.${randomUUID().slice(0, 6)}`,
        title: String(item.title || '').trim(),
        detail: String(item.detail || '').trim() || undefined,
        ownerMention: item.ownerMention ?? null,
        ownerSpeakerId: item.ownerSpeakerId ?? null,
        ownerPersonId: item.ownerPersonId || null,
        ownerBasis: item.ownerBasis || 'assigned',
        ownerConfidence: Number(item.ownerConfidence ?? 1),
        external: Boolean(item.external),
        due: item.due || null,
        dueText: item.dueText || null,
        evidence: Array.isArray(item.evidence) ? item.evidence : [],
        status: 'confirmed',
      };

      const payload = buildFeishuTaskPayload(todoObj, meeting, meOpenId, nameOf);
      try {
        const res = await accounts.runBackend((cfg) => apiClient.createFeishuTask(cfg, payload, { signal }));
        if (!res.ok) {
          failed = { id: todoObj.id, title: todoObj.title, message: res.authRequired.message };
          break;
        }
        const created = res.value || {};
        todoObj.status = 'pushed';
        todoObj.feishuTaskId = created.guid || '';
        todoObj.feishuTaskUrl = created.url || '';
        const idx = meetingTodos.findIndex((t) => t.id === todoObj.id);
        if (idx >= 0) meetingTodos[idx] = { ...meetingTodos[idx], ...todoObj };
        else meetingTodos.push(todoObj);

        meetingStore.patchMeeting(meeting.id, {
          todos: meetingTodos,
          status: 'pushed',
        });
        pushed.push({
          id: todoObj.id,
          title: todoObj.title,
          guid: todoObj.feishuTaskId,
          url: todoObj.feishuTaskUrl,
        });
      } catch (error) {
        failed = {
          id: todoObj.id,
          title: todoObj.title,
          message: safeErrorMessage(error, '创建飞书任务失败，请稍后重试。'),
        };
        break;
      }
    }

    if (pushed.length > 0 && knowledgeSync) {
      knowledgeSync.scheduleSync(meeting.id);
    }

    if (!failed) {
      draft.status = 'pushed';
      draft.pushed = pushed;
      const { session } = resolveSessionContext(ctx, draft.sessionId, draft.callId);
      emitPluginRecord(appendPluginRecord, session, TODO_PUSHED_RECORD_TYPE, {
        draftId,
        meetingId: meeting.id,
        pushedCount: pushed.length,
        pushed,
      });
    }

    return {
      draftId,
      meetingId: meeting.id,
      status: failed ? 'partial' : 'pushed',
      pushed,
      failed,
    };
  }

  function cancelTodoDraft({ draftId }) {
    const draft = stagedTodoDrafts.get(draftId);
    if (draft) {
      draft.status = 'cancelled';
      stagedTodoDrafts.delete(draftId);
    }
    return { ok: true, draftId };
  }

  // 1a. 注册系统提示段落（可选服务 systemPrompt）
  const registerPrompt = (sp) => {
    if (typeof sp?.section !== 'function') return;
    try {
      const dispose = sp.section(PROMPT_SECTION_NAME, ECHOMIND_PROMPT, { order: PROMPT_SECTION_ORDER });
      if (typeof dispose === 'function') disposers.push(dispose);
    } catch {
      ctx.logger?.warn?.('@local/echomind: systemPrompt 段落注册失败。');
    }
  };
  const immediateSp = getHostService(ctx, 'systemPrompt');
  if (immediateSp?.section) {
    registerPrompt(immediateSp);
  } else if (typeof ctx.inject === 'function') {
    ctx.inject(['systemPrompt'], (c) => registerPrompt(getHostService(c, 'systemPrompt')));
  }

  // 1b. 注册 5 个随包业务 Skill（可选服务 skills）
  const registerSkills = (skills) => {
    if (typeof skills?.registerProvider !== 'function') return;
    try {
      const dispose = skills.registerProvider((control) => createSkillProvider({ control, logger: ctx.logger }));
      if (typeof dispose === 'function') disposers.push(dispose);
    } catch {
      ctx.logger?.warn?.('@local/echomind: 内置 skill 注册失败。');
    }
  };
  const immediateSkills = getHostService(ctx, 'skills');
  if (immediateSkills) {
    registerSkills(immediateSkills);
  } else if (typeof ctx.inject === 'function') {
    ctx.inject(['skills'], (c) => registerSkills(getHostService(c, 'skills')));
  }

  // 2. 注册 8 个宿主模型工具（所有输出统一经 toToolOutput 清洗为无损 JSON）
  const tools = getHostService(ctx, 'tools');
  const registerTool = (def) =>
    tools.register({
      ...def,
      async execute(args, exec) {
        return toToolOutput(await def.execute(args ?? {}, exec ?? {}));
      },
    });

  // Tool 1: echomind_status（纯只读）
  registerTool({
    name: 'echomind_status',
    description:
      '查看 EchoMind 的当前运行状态：服务端连接与飞书账户信息、双轨录音与本机转写二进制是否就绪、语音模型下载状态、当前是否正在录音或后台处理、工作区目录及本地会议数量。纯只读，不能修改任何配置或凭据。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: textRender },
    async execute(_args, exec) {
      const state = await accounts.getState();
      const binaries = binaryManager.getStatus();
      let models = null;
      if (binaries.transcribe.ready) {
        try {
          models = await transcriberManager.checkModels(exec.signal);
        } catch {
          models = null;
        }
      }
      const { workspaceDir } = resolveSessionContext(ctx, exec.agent?.id || null, exec.callId);
      const recording = captureManager.getSnapshot();
      const jobs = pipelineRunner.listJobs();
      const connected = Boolean(state.activeAccount && state.activeAccount.status === 'ok');
      return {
        connected,
        serverUrl: state.serverUrl,
        account: state.activeAccount
          ? {
              name: state.activeAccount.name,
              companyName: state.activeAccount.companyName,
              status: state.activeAccount.status,
              missingScopes: state.activeAccount.missingScopes,
            }
          : null,
        accountsCount: state.accounts.length,
        binaries: {
          platform: binaries.platform,
          ready: binaries.ready,
          captureReady: binaries.capture.ready,
          transcribeReady: binaries.transcribe.ready,
        },
        modelsReady: Boolean(models?.ready),
        modelsDownloadBytes: models?.downloadBytes ?? null,
        recording: recording
          ? {
              meetingId: recording.meetingId,
              title: recording.title,
              paused: recording.paused,
              elapsedMs: recording.elapsedMs,
              marksCount: recording.marks.length,
            }
          : null,
        activeJobs: jobs,
        dataRoot: paths.dataRoot,
        recordingsDir: paths.resolveRecordingsDir({ workspaceDir }),
        meetingsCount: meetingStore.countMeetings({ workspaceDir }),
      };
    },
  });

  // Tool 2: echomind_recording_control
  registerTool({
    name: 'echomind_recording_control',
    description:
      '控制本机 EchoMind 双轨会议录音：支持 check_env（检查麦克风/系统录音权限与正在运行的腾讯会议/飞书会议/Zoom）、start（开启双轨录音）、pause（暂停）、resume（继续）、mark（标记重点时刻）、stop（结束录音并自动排队本机转写与生成纪要）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['check_env', 'start', 'pause', 'resume', 'mark', 'stop'],
          description: '录音控制动作。',
        },
        title: { type: 'string', description: '可选：开始录音时的会议标题。' },
        source: {
          type: 'string',
          enum: ['tencent', 'feishu', 'zoom', 'offline', 'other'],
          description: '可选：会议来源形式。',
        },
        systemPids: {
          type: 'array',
          items: { type: 'integer' },
          description: '可选（仅 macOS）：仅录制指定会议进程的 audioPids。',
        },
      },
      required: ['action'],
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: textRender },
    async execute(args, exec) {
      const sessionId = exec.agent?.id || null;
      const { session, workspaceDir } = resolveSessionContext(ctx, sessionId, exec.callId);
      const action = args.action;

      if (action === 'check_env') {
        const binaries = binaryManager.getStatus();
        const permissions = binaries.capture.ready ? await captureManager.checkPermissions(exec.signal) : null;
        const runningMeetings = binaries.capture.ready ? await captureManager.detectMeetings(exec.signal) : [];
        return {
          action: 'check_env',
          binariesReady: binaries.ready,
          captureReady: binaries.capture.ready,
          transcribeReady: binaries.transcribe.ready,
          permissions,
          runningMeetings,
          isRecording: captureManager.isRecording(),
        };
      }

      if (action === 'start') {
        const snap = await captureManager.startRecording({
          title: args.title || '',
          source: args.source || 'other',
          systemPids: args.systemPids,
          workspaceDir,
          signal: exec.signal,
        });
        const card = {
          kind: RECORDING_CARD_KIND,
          action: 'started',
          meetingId: snap.meetingId,
          title: snap.title || '新会议',
          source: snap.source,
          warnings: snap.warnings,
          message: '已开始双轨会议录音，小智办公窗口底部已显示实时电平与控制条。录音结束后将自动转写并生成纪要。',
        };
        emitPluginRecord(appendPluginRecord, session, RECORDING_EVENT_RECORD_TYPE, card);
        return card;
      }

      if (action === 'pause' || action === 'resume' || action === 'mark') {
        const snap = await captureManager.sendCommand(action);
        return {
          action,
          ok: true,
          meetingId: snap?.meetingId || null,
          paused: Boolean(snap?.paused),
          elapsedMs: snap?.elapsedMs || 0,
          marksCount: snap?.marks?.length || 0,
          message: action === 'mark' ? '已为当前时刻打上重点标记。' : action === 'pause' ? '已暂停录音。' : '已继续录音。',
        };
      }

      if (action === 'stop') {
        const before = await captureManager.stopRecording();
        if (!before) {
          throw new ApiError('当前没有正在进行的会议录音。', { code: 'NOT_RECORDING' });
        }
        const card = {
          kind: RECORDING_CARD_KIND,
          action: 'stopped',
          meetingId: before.meetingId,
          title: before.title || '新会议',
          elapsedMs: before.elapsedMs,
          message: `已结束会议「${before.meetingId}」的录音，正在后台排队进行本机离线转写、声纹识别与 DeepSeek 纪要生成。`,
        };
        emitPluginRecord(appendPluginRecord, session, RECORDING_EVENT_RECORD_TYPE, card);
        return card;
      }

      throw new ApiError(`不支持的录音动作：${action}`, { code: 'INVALID_ARGUMENT' });
    },
  });

  // Tool 3: echomind_import_audio
  registerTool({
    name: 'echomind_import_audio',
    description:
      '导入本机已有的会议音频文件（WAV/M4A/MP3/FLAC/OGG/AAC/MP4/WEBM，上限 500 MB）到 EchoMind 工作区，并自动触发本机离线转写、说话人分离与纪要生成。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        filePath: { type: 'string', description: '本机音频文件绝对路径。' },
        title: { type: 'string', description: '可选：会议标题，默认取文件名。' },
        source: {
          type: 'string',
          enum: ['offline', 'tencent', 'feishu', 'zoom', 'other'],
          description: '可选：会议形式，默认 offline（线下/手机录音）。',
        },
        scene: {
          type: 'string',
          enum: ['in-person', 'online'],
          description: '可选：说话人分离场景，默认 in-person。',
        },
        speakers: {
          type: 'integer',
          minimum: 1,
          maximum: 20,
          description: '可选：已知的参会发言人数（1-20）。',
        },
      },
      required: ['filePath'],
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: textRender },
    async execute(args, exec) {
      const sessionId = exec.agent?.id || null;
      const { session, workspaceDir } = resolveSessionContext(ctx, sessionId, exec.callId);
      const imported = await audioImporter.importAudio({
        filePath: args.filePath,
        title: args.title || '',
        source: args.source || 'offline',
        workspaceDir,
      });
      meetingStore.ensureMeetingSkeleton({
        meetingId: imported.meetingId,
        outDir: imported.outDir,
        title: imported.title,
        source: imported.source,
        startedAt: imported.startedAt,
        durationMs: imported.durationMs,
      });
      meetingStore.patchMeeting(imported.meetingId, { status: 'transcribing' });
      const hints = {
        scene: args.scene || 'in-person',
        ...(args.speakers ? { speakers: args.speakers } : {}),
      };
      void pipelineRunner.rediarize(imported.meetingId, hints).catch(() => {});

      const card = {
        kind: RECORDING_CARD_KIND,
        action: 'imported',
        meetingId: imported.meetingId,
        title: imported.title,
        durationMs: imported.durationMs,
        segments: imported.segments,
        message: `已导入音频并创建会议「${imported.title}」（${imported.meetingId}），正在后台本机离线转写并生成纪要。`,
      };
      emitPluginRecord(appendPluginRecord, session, RECORDING_EVENT_RECORD_TYPE, card);
      return card;
    },
  });

  // Tool 4: echomind_list_meetings
  registerTool({
    name: 'echomind_list_meetings',
    description:
      '查询与筛选本机工作区的 EchoMind 历史会议列表，返回标准中文 columns + rows（可直接配合 query_result_chart 展示图表）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        keyword: { type: 'string', description: '按会议标题、纪要概要、议题或待办关键词筛选。' },
        status: {
          type: 'string',
          enum: ['recording', 'transcribing', 'review', 'ready', 'pushed', 'failed'],
          description: '按处理状态筛选。',
        },
        source: {
          type: 'string',
          enum: ['tencent', 'feishu', 'zoom', 'offline', 'other'],
          description: '按会议形式筛选。',
        },
        fromDate: { type: 'string', description: '开始日期（YYYY-MM-DD）。' },
        toDate: { type: 'string', description: '结束日期（YYYY-MM-DD）。' },
        limit: { type: 'integer', minimum: 1, maximum: 200, description: '返回条数上限，默认 50。' },
      },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: textRender },
    async execute(args, exec) {
      const { workspaceDir } = resolveSessionContext(ctx, exec.agent?.id || null, exec.callId);
      const res = meetingStore.listMeetings({ ...args, workspaceDir });
      const { columns, rows } = formatMeetingListRows(res.meetings);
      return {
        total: res.total,
        returned: res.meetings.length,
        columns,
        rows,
        meetings: res.meetings.map((m) => ({
          id: m.id,
          title: m.title,
          source: m.source,
          startedAt: m.startedAt,
          durationMs: m.durationMs || 0,
          status: m.status,
          todosCount: Array.isArray(m.todos) ? m.todos.length : 0,
          hasMinutes: Boolean(m.minutes),
        })),
      };
    },
  });

  // Tool 5: echomind_get_meeting
  registerTool({
    name: 'echomind_get_meeting',
    description:
      '获取单场会议的结构化纪要（概要、议题、结论、决定、待议问题）、待办清单、说话人列表与知识库同步状态，并在对话尾部渲染纪要卡片。默认不返回全量逐字稿以保护隐私和上下文；需要原话出处请调用 echomind_search_transcript。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        meetingId: { type: 'string', description: '会议 ID（例如 rec-1791884868281）。' },
      },
      required: ['meetingId'],
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: textRender },
    async execute(args, exec) {
      const sessionId = exec.agent?.id || null;
      const { session, workspaceDir } = resolveSessionContext(ctx, sessionId, exec.callId);
      const meeting = meetingStore.getMeeting(args.meetingId, { workspaceDir, includeTranscript: true });
      if (!meeting) {
        throw new ApiError(`找不到会议「${args.meetingId}」。请先调用 echomind_list_meetings 确认会议编号。`, {
          code: 'NOT_FOUND',
        });
      }
      const people = meetingStore.loadDirectoryCache({ allowStale: true })?.people || [];
      const personName = (id) => people.find((p) => p.id === id)?.name || null;

      const speakers = (meeting.transcript?.speakers || []).map((sp) => ({
        id: sp.id,
        label: sp.label,
        resolvedName: personName(sp.personId) || sp.label,
        personId: sp.personId || null,
        track: sp.track,
        source: sp.source,
        ...(sp.confidence != null ? { confidence: sp.confidence } : {}),
      }));

      const payload = {
        kind: MINUTES_CARD_KIND,
        meetingId: meeting.id,
        title: meeting.title,
        source: meeting.source,
        sourceLabel: SOURCE_LABELS[meeting.source] || '其他',
        startedAt: meeting.startedAt,
        durationMs: meeting.durationMs || 0,
        status: meeting.status,
        statusLabel: STATUS_LABELS[meeting.status] || meeting.status,
        scene: meeting.transcript?.scene || 'online',
        speakers,
        segmentsCount: Array.isArray(meeting.transcript?.segments) ? meeting.transcript.segments.length : 0,
        hasAudio: meetingStore.hasLocalAudio(meeting.id),
        minutes: meeting.minutes || null,
        todos: (meeting.todos || []).map((t) => ({
          id: t.id,
          title: t.title,
          detail: t.detail || '',
          ownerMention: t.ownerMention || null,
          ownerPersonId: t.ownerPersonId || null,
          ownerName: personName(t.ownerPersonId) || (t.external ? t.ownerMention || '外部联系人' : null),
          ownerBasis: t.ownerBasis || 'unresolved',
          ownerConfidence: t.ownerConfidence ?? 0,
          external: Boolean(t.external),
          due: t.due || null,
          dueText: t.dueText || null,
          evidence: Array.isArray(t.evidence) ? t.evidence : [],
          status: t.status || 'draft',
          feishuTaskId: t.feishuTaskId || null,
          feishuTaskUrl: t.feishuTaskUrl || null,
        })),
        knowledge: {
          off: Boolean(meeting.knowledge?.off),
          synced: Boolean(meeting.knowledge?.sentHash),
          status: knowledgeSync.getStatus(meeting.id),
        },
        activeJob: pipelineRunner.getJob(meeting.id),
      };

      emitPluginRecord(appendPluginRecord, session, MINUTES_PRESENTED_RECORD_TYPE, {
        meetingId: meeting.id,
        title: meeting.title,
      });
      return payload;
    },
  });

  // Tool 6: echomind_search_transcript
  registerTool({
    name: 'echomind_search_transcript',
    description:
      '在本机会议逐字稿中离线按关键词、说话人或时间区间检索原话证据，仅返回命中片段及前后文（最多 30 条 / 12,000 字），不上传服务端。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        meetingId: { type: 'string', description: '可选：限定单场会议 ID；不填则跨全部本机会议检索。' },
        keyword: { type: 'string', description: '关键词（精确子串匹配）。' },
        speakerName: { type: 'string', description: '可选：按说话人姓名或标签过滤（如「张三」或「说话人 2」）。' },
        startMs: { type: 'integer', minimum: 0, description: '可选：起始毫秒时间戳。' },
        endMs: { type: 'integer', minimum: 0, description: '可选：结束毫秒时间戳。' },
        limit: { type: 'integer', minimum: 1, maximum: 30, description: '返回命中条数上限，默认 15。' },
      },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: textRender },
    async execute(args, exec) {
      if (!args.keyword && !args.speakerName && args.startMs == null && args.endMs == null && !args.meetingId) {
        throw new ApiError('请至少提供 keyword、speakerName、meetingId 或时间范围之一。', {
          code: 'INVALID_ARGUMENT',
        });
      }
      const { workspaceDir } = resolveSessionContext(ctx, exec.agent?.id || null, exec.callId);
      const people = meetingStore.loadDirectoryCache({ allowStale: true })?.people || [];
      return meetingStore.searchTranscript({ ...args, workspaceDir, people });
    },
  });

  // Tool 7: echomind_process_meeting
  registerTool({
    name: 'echomind_process_meeting',
    description:
      '对已有会议执行本地重处理：rediarize（切换面对面/线上场景或指定说话人数重新分离并更新纪要）、regenerate_minutes（基于最新说话人重新调用 DeepSeek 生成纪要）、rename_speaker（仅修改本地会议里的说话人名称，不自动上传声纹）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        meetingId: { type: 'string', description: '会议 ID。' },
        action: {
          type: 'string',
          enum: ['rediarize', 'regenerate_minutes', 'rename_speaker'],
          description: '处理动作。',
        },
        scene: { type: 'string', enum: ['in-person', 'online'], description: 'rediarize 时必填：会议场景。' },
        speakers: { type: 'integer', minimum: 1, maximum: 20, description: 'rediarize 时可选：参与说话人数。' },
        speakerId: { type: 'string', description: 'rename_speaker 时必填：说话人编号（如 S2）。' },
        speakerName: { type: 'string', description: 'rename_speaker 时必填：新的说话人姓名。' },
        personId: { type: 'string', description: 'rename_speaker 时可选：通讯录人员 openId。' },
      },
      required: ['meetingId', 'action'],
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: textRender },
    async execute(args, exec) {
      const meeting = meetingStore.getMeeting(args.meetingId, { includeTranscript: true });
      if (!meeting) {
        throw new ApiError(`找不到会议「${args.meetingId}」。`, { code: 'NOT_FOUND' });
      }

      if (args.action === 'rename_speaker') {
        if (!args.speakerId || !args.speakerName) {
          throw new ApiError('rename_speaker 必须提供 speakerId 和 speakerName。', { code: 'INVALID_ARGUMENT' });
        }
        let resolvedPersonId = args.personId || null;
        if (!resolvedPersonId) {
          const people = meetingStore.loadDirectoryCache({ allowStale: true })?.people || [];
          const exact = people.filter((p) => p.name === args.speakerName.trim());
          if (exact.length === 1) resolvedPersonId = exact[0].id;
        }
        const updated = meetingStore.renameSpeaker(args.meetingId, args.speakerId, {
          personId: resolvedPersonId,
          label: args.speakerName.trim(),
          source: 'manual',
        });
        if (!updated) {
          throw new ApiError(`会议中找不到说话人「${args.speakerId}」。`, { code: 'NOT_FOUND' });
        }
        return {
          action: 'rename_speaker',
          ok: true,
          meetingId: args.meetingId,
          speakerId: args.speakerId,
          speakerName: args.speakerName.trim(),
          personId: resolvedPersonId,
          message: `已将 ${args.speakerId} 命名为「${args.speakerName.trim()}」。如需让系统记住其声纹，请在会议详情面板勾选「记住声音」。`,
        };
      }

      const active = await accounts.getActiveBackend();
      if (!active.ok) return active.authRequired;

      if (args.action === 'rediarize') {
        if (!args.scene) {
          throw new ApiError('rediarize 必须提供 scene（in-person 或 online）。', { code: 'INVALID_ARGUMENT' });
        }
        void pipelineRunner
          .rediarize(args.meetingId, { scene: args.scene, speakers: args.speakers }, { signal: exec.signal })
          .catch(() => {});
        return {
          kind: RECORDING_CARD_KIND,
          action: 'rediarize',
          meetingId: args.meetingId,
          title: meeting.title,
          message: `已开始按「${args.scene === 'in-person' ? '面对面' : '线上'}」${args.speakers ? `（${args.speakers} 人）` : ''}重新区分说话人并更新纪要。`,
        };
      }

      if (args.action === 'regenerate_minutes') {
        void pipelineRunner.regenerateMinutes(args.meetingId, { signal: exec.signal }).catch(() => {});
        return {
          kind: RECORDING_CARD_KIND,
          action: 'regenerate_minutes',
          meetingId: args.meetingId,
          title: meeting.title,
          message: `已开始为会议「${meeting.title}」重新生成纪要与待办草稿。`,
        };
      }

      throw new ApiError(`不支持的处理动作：${args.action}`, { code: 'INVALID_ARGUMENT' });
    },
  });

  // Tool 8: echomind_stage_todo_push（只暂存草稿，绝不直接调用飞书创建任务）
  registerTool({
    name: 'echomind_stage_todo_push',
    description:
      '整理会议待办并生成「待办确认并推送飞书」交互卡片（仅在宿主内存暂存草稿，绝不直接创建飞书任务）。由用户在卡片中核对勾选并点击「确认并推送到飞书」后执行。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        meetingId: { type: 'string', description: '会议 ID。' },
        todoIds: {
          type: 'array',
          items: { type: 'string' },
          description: '可选：仅暂存指定的待办 ID；不传则默认带入该会议全部尚未推送的待办。',
        },
      },
      required: ['meetingId'],
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: textRender },
    async execute(args, exec) {
      const active = await accounts.getActiveBackend();
      if (!active.ok) return active.authRequired;

      const sessionId = exec.agent?.id || null;
      const { session, workspaceDir } = resolveSessionContext(ctx, sessionId, exec.callId);
      const meeting = meetingStore.getMeeting(args.meetingId, { workspaceDir, includeTranscript: true });
      if (!meeting) {
        throw new ApiError(`找不到会议「${args.meetingId}」。`, { code: 'NOT_FOUND' });
      }
      const allTodos = Array.isArray(meeting.todos) ? meeting.todos : [];
      const wanted = Array.isArray(args.todoIds) && args.todoIds.length > 0 ? new Set(args.todoIds) : null;
      const pending = allTodos.filter((t) => {
        if (!t || t.feishuTaskId) return false;
        if (wanted && !wanted.has(t.id)) return false;
        return true;
      });
      if (pending.length === 0) {
        return {
          meetingId: meeting.id,
          title: meeting.title,
          pendingCount: 0,
          message: '该会议当前没有尚未推送的待办事项。',
        };
      }

      const people = await pipelineRunner.loadDirectory(false, exec.signal);
      const nameOf = (pid) => people.find((p) => p.id === pid)?.name || null;

      const draftId = `em_draft_${randomUUID().slice(0, 12)}`;
      const stagedTodos = pending.map((t) => ({
        id: t.id,
        selected: true,
        title: t.title,
        detail: t.detail || '',
        ownerMention: t.ownerMention || null,
        ownerSpeakerId: t.ownerSpeakerId || null,
        ownerPersonId: t.ownerPersonId || null,
        ownerName: nameOf(t.ownerPersonId) || (t.external ? t.ownerMention || '外部联系人' : null),
        ownerBasis: t.ownerBasis || 'unresolved',
        ownerConfidence: t.ownerConfidence ?? 0,
        external: Boolean(t.external),
        due: t.due || null,
        dueText: t.dueText || null,
        evidence: Array.isArray(t.evidence) ? t.evidence : [],
      }));

      storeTodoDraft({
        draftId,
        meetingId: meeting.id,
        accountId: active.account.id,
        sessionId,
        callId: exec.callId || null,
        status: 'pending',
        todos: stagedTodos,
        createdAt: new Date(now()).toISOString(),
      });

      const payload = {
        kind: TODO_DRAFT_KIND,
        draftId,
        meetingId: meeting.id,
        meetingTitle: meeting.title,
        todos: stagedTodos,
        message: `已整理 ${stagedTodos.length} 条待推送待办，请在下方确认卡片核对负责人和截止日期后点击「确认并推送到飞书」。`,
      };
      emitPluginRecord(appendPluginRecord, session, TODO_DRAFT_RECORD_TYPE, {
        draftId,
        meetingId: meeting.id,
        count: stagedTodos.length,
      });
      return payload;
    },
  });

  // 3. 注册 TypertRemoteService ("echomind")
  const remote = registerEchoMindRemote(ctx, {
    ...(hostTypert || {}),
    ...(deps.typert || {}),
    accounts,
    binaryManager,
    captureManager,
    transcriberManager,
    meetingStore,
    pipelineRunner,
    voiceprintManager,
    knowledgeSync,
    playbackServer,
    apiClient,
    confirmPushTodosFn: confirmPushTodos,
    cancelTodoDraftFn: cancelTodoDraft,
    paths,
  });

  function dispose() {
    for (const fn of disposers) {
      try {
        fn();
      } catch {
        // Ignore cleanup errors.
      }
    }
  }

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => dispose, '@local/echomind: cleanup');
  }

  return {
    paths,
    accounts,
    binaryManager,
    captureManager,
    transcriberManager,
    audioImporter,
    meetingStore,
    voiceprintManager,
    knowledgeSync,
    pipelineRunner,
    playbackServer,
    stagedTodoDrafts,
    remoteHandlers: remote.handlers,
    confirmPushTodos,
    cancelTodoDraft,
    dispose,
  };
}

export function apply(ctx) {
  return setupEchoMind(ctx);
}
