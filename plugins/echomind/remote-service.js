import { ApiError, safeErrorMessage } from './api-client.js';

// 宿主 RPC 服务「echomind」：
// 设置页、插件页、悬浮录音条、右侧栏会议详情播放器、待办确认卡片等前端 UI
// 均通过 connection.rpc.call("/api", "echomind/<方法>", { args }, signal) 调用这里的方法。
// 高危外部副作用操作（推飞书任务、知识库撤回/上传、声纹发卡/删除、公司管理）只挂在此 RPC 上，不暴露为模型工具。

export const REMOTE_SERVICE_NAME = 'echomind';
const INTERNAL_ERROR_MESSAGE = '操作失败，请稍后重试。';

export class EchoMindRemoteError extends Error {
  constructor(code, message) {
    super(message || INTERNAL_ERROR_MESSAGE);
    this.name = 'EchoMindRemoteError';
    this.code = code || 'INTERNAL_ERROR';
  }
}

function wrapError(error) {
  if (error instanceof EchoMindRemoteError) return error;
  if (error instanceof ApiError) {
    const code = typeof error.code === 'string' && /^[A-Z][A-Z0-9_]*$/u.test(error.code) ? error.code : 'API_ERROR';
    return new EchoMindRemoteError(code, safeErrorMessage(error, INTERNAL_ERROR_MESSAGE));
  }
  if (error?.name === 'CredentialStoreError') {
    return new EchoMindRemoteError(error.code || 'CREDENTIAL_ERROR', safeErrorMessage(error, INTERNAL_ERROR_MESSAGE));
  }
  return new EchoMindRemoteError('INTERNAL_ERROR', INTERNAL_ERROR_MESSAGE);
}

export const RPC_METHOD_NAMES = Object.freeze([
  'getState',
  'saveSettings',
  'testConnection',
  'startAuthorization',
  'pollAuthorization',
  'cancelAuthorization',
  'setActiveAccount',
  'disconnectAccount',
  'getRuntimeStatus',
  'installBinaries',
  'downloadModels',
  'checkPermissions',
  'requestPermission',
  'openPrivacySettings',
  'detectMeetings',
  'getLiveSnapshot',
  'startRecording',
  'controlRecording',
  'listMeetings',
  'getMeetingDetail',
  'getTranscriptPage',
  'getPlaybackInfo',
  'getAudioSlice',
  'listDirectory',
  'renameSpeaker',
  'rediarizeMeeting',
  'regenerateMinutes',
  'retryMeeting',
  'dismissJob',
  'confirmPushTodos',
  'cancelTodoDraft',
  'setKnowledgeSync',
  'refreshKnowledgeStatus',
  'listVoiceprints',
  'askVoiceprintConsent',
  'deleteVoiceprint',
  'listCompanies',
  'addCompany',
  'checkCompany',
  'replaceCompanySecret',
  'toggleCompany',
]);

export function createEchoMindRemoteHandlers(deps = {}) {
  const {
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
    confirmPushTodosFn,
    cancelTodoDraftFn,
    paths,
  } = deps;

  if (!accounts) {
    throw new TypeError('createEchoMindRemoteHandlers 需要 deps.accounts。');
  }

  const guard = async (fn) => {
    try {
      return await fn();
    } catch (error) {
      throw wrapError(error);
    }
  };

  const unwrapBackend = (res) => {
    if (!res.ok) {
      throw new EchoMindRemoteError('UNAUTHORIZED', res.authRequired.message);
    }
    return res.value;
  };

  return {
    getState() {
      return guard(() => accounts.getState());
    },
    saveSettings(patch) {
      return guard(() => accounts.saveSettings(patch));
    },
    testConnection(serverUrl, joinCode, signal) {
      return guard(() => accounts.testConnection(serverUrl, joinCode, signal));
    },
    startAuthorization(joinCode, signal) {
      return guard(() => accounts.startAuthorization({ joinCode }, signal));
    },
    pollAuthorization(requestId) {
      return guard(() => accounts.pollAuthorization(requestId));
    },
    cancelAuthorization(requestId) {
      return guard(() => accounts.cancelAuthorization(requestId));
    },
    setActiveAccount(accountId) {
      return guard(() => accounts.setActiveAccount(accountId));
    },
    disconnectAccount(accountId) {
      return guard(() => accounts.disconnectAccount(accountId));
    },

    getRuntimeStatus(signal) {
      return guard(async () => {
        const binaries = binaryManager.getStatus();
        let models = null;
        if (binaries.transcribe.ready) {
          try {
            models = await transcriberManager.checkModels(signal);
          } catch {
            models = null;
          }
        }
        let permissions = null;
        if (binaries.capture.ready) {
          try {
            permissions = await captureManager.checkPermissions(signal);
          } catch {
            permissions = null;
          }
        }
        return {
          binaries,
          models,
          modelDownload: transcriberManager.getDownloadProgress(),
          permissions,
          dataRoot: paths.dataRoot,
          recordingsDir: paths.resolveRecordingsDir(),
          meetingsCount: meetingStore.countMeetings(),
        };
      });
    },

    installBinaries(signal) {
      return guard(() => binaryManager.installMissing({ signal }));
    },

    downloadModels(signal) {
      return guard(async () => {
        const res = await transcriberManager.downloadModels({ signal });
        const resumed = typeof pipelineRunner?.resumeWaitingModelsJobs === 'function'
          ? pipelineRunner.resumeWaitingModelsJobs()
          : [];
        return { ...(res && typeof res === 'object' ? res : { ready: true }), resumedMeetingIds: resumed };
      });
    },

    checkPermissions(signal) {
      return guard(() => captureManager.checkPermissions(signal));
    },

    requestPermission(kind, signal) {
      return guard(() => captureManager.requestPermission(kind, signal));
    },

    openPrivacySettings(kind) {
      return guard(() => captureManager.openPrivacySettings(kind));
    },

    detectMeetings(signal) {
      return guard(() => captureManager.detectMeetings(signal));
    },

    getLiveSnapshot() {
      return guard(async () => ({
        recording: captureManager.getSnapshot(),
        jobs: pipelineRunner.listJobs(),
        modelDownload: transcriberManager.getDownloadProgress(),
        binaryInstall: binaryManager.getStatus().installProgress,
      }));
    },

    startRecording(options, signal) {
      return guard(() => captureManager.startRecording({ ...(options && typeof options === 'object' ? options : {}), signal }));
    },

    controlRecording(command) {
      return guard(() => captureManager.sendCommand(command));
    },

    listMeetings(query) {
      return guard(() => {
        const res = meetingStore.listMeetings(query && typeof query === 'object' ? query : {});
        return {
          total: res.total,
          meetings: res.meetings.map((m) => ({
            id: m.id,
            title: m.title,
            source: m.source,
            startedAt: m.startedAt,
            durationMs: m.durationMs || 0,
            status: m.status,
            todosCount: Array.isArray(m.todos) ? m.todos.length : 0,
            hasMinutes: Boolean(m.minutes),
            hasAudio: meetingStore.hasLocalAudio(m.id),
            knowledgeOff: Boolean(m.knowledge?.off),
          })),
        };
      });
    },

    getMeetingDetail(meetingId) {
      return guard(() => {
        const meeting = meetingStore.getMeeting(meetingId, { includeTranscript: true });
        if (!meeting) throw new EchoMindRemoteError('NOT_FOUND', '找不到指定的会议记录。');
        const knowledgeStatus = knowledgeSync ? knowledgeSync.getStatus(meetingId) : {};
        return {
          meeting: {
            id: meeting.id,
            title: meeting.title,
            source: meeting.source,
            startedAt: meeting.startedAt,
            durationMs: meeting.durationMs || 0,
            status: meeting.status,
            recorderId: meeting.recorderId || '',
            participantIds: meeting.participantIds || [],
            minutes: meeting.minutes || null,
            todos: meeting.todos || [],
            knowledge: meeting.knowledge || { off: false },
            scene: meeting.transcript?.scene || 'online',
            speakers: meeting.transcript?.speakers || [],
            segmentsCount: Array.isArray(meeting.transcript?.segments) ? meeting.transcript.segments.length : 0,
            hasAudio: meetingStore.hasLocalAudio(meetingId),
          },
          job: pipelineRunner.getJob(meetingId),
          knowledgeStatus,
        };
      });
    },

    getTranscriptPage(meetingId, offset, limit, speakerId, keyword) {
      return guard(() => {
        const page = meetingStore.getTranscriptPage(meetingId, { offset, limit, speakerId, keyword });
        if (!page) throw new EchoMindRemoteError('NOT_FOUND', '该会议还没有本地逐字稿。');
        return page;
      });
    },

    getPlaybackInfo(meetingId) {
      return guard(() => playbackServer.getPlaybackInfo(meetingId));
    },

    getAudioSlice(meetingId, startMs, durationMs) {
      return guard(() => playbackServer.getAudioSlice(meetingId, startMs, durationMs));
    },

    listDirectory(refresh, signal) {
      return guard(async () => {
        const people = await pipelineRunner.loadDirectory(Boolean(refresh), signal);
        return { people };
      });
    },

    renameSpeaker(meetingId, speakerId, personId, label, rememberVoice, signal) {
      return guard(async () => {
        const updated = meetingStore.renameSpeaker(meetingId, speakerId, {
          personId: personId || null,
          label: label || '',
          source: 'manual',
        });
        if (!updated) throw new EchoMindRemoteError('NOT_FOUND', '找不到指定的会议或说话人。');
        let voiceprintResult = null;
        if (rememberVoice && personId && voiceprintManager) {
          const vpRes = await voiceprintManager.rememberSpeakerVoice(
            { meetingId, speakerId, openId: personId, meetingTitle: updated.title },
            signal,
          );
          voiceprintResult = unwrapBackend(vpRes);
        }
        return {
          meetingId,
          speakers: updated.transcript?.speakers || [],
          voiceprint: voiceprintResult,
        };
      });
    },

    rediarizeMeeting(meetingId, scene, speakers, signal) {
      return guard(async () => {
        void pipelineRunner.rediarize(meetingId, { scene, speakers: speakers || undefined }, { signal }).catch(() => {});
        return { ok: true, meetingId, job: pipelineRunner.getJob(meetingId) };
      });
    },

    regenerateMinutes(meetingId, signal) {
      return guard(async () => {
        void pipelineRunner.regenerateMinutes(meetingId, { signal }).catch(() => {});
        return { ok: true, meetingId, job: pipelineRunner.getJob(meetingId) };
      });
    },

    retryMeeting(meetingId, signal) {
      return guard(async () => {
        void pipelineRunner.retry(meetingId, { signal }).catch(() => {});
        return { ok: true, meetingId, job: pipelineRunner.getJob(meetingId) };
      });
    },

    dismissJob(meetingId) {
      return guard(async () => ({
        ok: true,
        meetingId,
        dismissed: Boolean(pipelineRunner.dismissJob?.(meetingId)),
      }));
    },

    confirmPushTodos(draftId, editedTodos, signal) {
      return guard(async () => {
        if (typeof draftId !== 'string' || !draftId) {
          throw new EchoMindRemoteError('INVALID_REQUEST', '缺少待办推送草稿标识。');
        }
        if (typeof confirmPushTodosFn !== 'function') {
          throw new EchoMindRemoteError('NOT_CONFIGURED', '待办推送服务未初始化。');
        }
        return confirmPushTodosFn({ draftId, editedTodos, signal });
      });
    },

    cancelTodoDraft(draftId) {
      return guard(async () => {
        if (typeof draftId !== 'string' || !draftId) {
          throw new EchoMindRemoteError('INVALID_REQUEST', '缺少待办推送草稿标识。');
        }
        if (typeof cancelTodoDraftFn !== 'function') {
          throw new EchoMindRemoteError('NOT_CONFIGURED', '待办取消服务未初始化。');
        }
        return cancelTodoDraftFn({ draftId });
      });
    },

    setKnowledgeSync(meetingId, enabled) {
      return guard(async () => {
        const st = await knowledgeSync.setKnowledgeOn(meetingId, Boolean(enabled));
        if (!st) throw new EchoMindRemoteError('NOT_FOUND', '找不到指定的会议记录。');
        return st;
      });
    },

    refreshKnowledgeStatus(meetingId) {
      return guard(() => knowledgeSync.refreshStatus(meetingId));
    },

    listVoiceprints(signal) {
      return guard(async () => {
        const raw = unwrapBackend(await voiceprintManager.listVoiceprints(signal));
        const list = Array.isArray(raw?.voiceprints) ? raw.voiceprints : [];
        let people = [];
        try {
          people = await pipelineRunner.loadDirectory(false, signal);
        } catch {
          people = [];
        }
        const byOpenId = new Map();
        for (const p of people) {
          if (p?.id) byOpenId.set(p.id, p);
          if (p?.feishuOpenId) byOpenId.set(p.feishuOpenId, p);
        }
        const state = await accounts.getState();
        const meOpenId = state?.activeAccount?.openId || '';
        const voiceprints = list.map((vp) => {
          const person = byOpenId.get(vp.openId) || null;
          return {
            ...vp,
            name: person?.name || '',
            department: person?.department || '',
            title: person?.title || '',
            isSelf: Boolean(meOpenId && vp.openId === meOpenId),
          };
        });
        const colleagues = people
          .filter((p) => p && !p.external && p.id)
          .map((p) => ({
            id: p.id,
            name: p.name || p.id,
            department: p.department || '',
            title: p.title || '',
            isSelf: Boolean(meOpenId && p.id === meOpenId),
          }));
        return { voiceprints, colleagues };
      });
    },

    askVoiceprintConsent(openId, meetingTitle, signal) {
      return guard(async () => unwrapBackend(await voiceprintManager.askConsent(openId, meetingTitle, signal)));
    },

    deleteVoiceprint(openId, signal) {
      return guard(async () => unwrapBackend(await voiceprintManager.deleteVoiceprint(openId, signal)));
    },

    listCompanies(signal) {
      return guard(async () => unwrapBackend(await accounts.runBackend((cfg) => apiClient.listCompanies(cfg, { signal }))));
    },

    addCompany(appId, appSecret, signal) {
      return guard(async () =>
        unwrapBackend(await accounts.runBackend((cfg) => apiClient.addCompany(cfg, { appId, appSecret }, { signal }))),
      );
    },

    checkCompany(companyId, signal) {
      return guard(async () =>
        unwrapBackend(await accounts.runBackend((cfg) => apiClient.checkCompany(cfg, companyId, { signal }))),
      );
    },

    replaceCompanySecret(companyId, appSecret, signal) {
      return guard(async () =>
        unwrapBackend(
          await accounts.runBackend((cfg) => apiClient.replaceCompanySecret(cfg, companyId, appSecret, { signal })),
        ),
      );
    },

    toggleCompany(companyId, enabled, signal) {
      return guard(async () =>
        unwrapBackend(
          await accounts.runBackend((cfg) => apiClient.toggleCompany(cfg, companyId, Boolean(enabled), { signal })),
        ),
      );
    },
  };
}

/**
 * 宿主提供 @deepseek-ai/dsh-typert-protocol 时注册 TypertRemoteService（"echomind"）。
 */
export function registerEchoMindRemote(ctx, deps = {}) {
  const { TypertRemoteService, Remote, RemoteError } = deps;
  const handlers = createEchoMindRemoteHandlers(deps);

  if (!TypertRemoteService || !Remote || !RemoteError || typeof ctx?.plugin !== 'function') {
    return { serviceClass: null, handlers };
  }

  const toRemoteError = (error) => {
    const safe = wrapError(error);
    return new RemoteError(safe.code, safe.message, {});
  };

  const initializers = [];
  class EchoMindService extends TypertRemoteService {
    constructor(serviceCtx) {
      super(serviceCtx, REMOTE_SERVICE_NAME);
      for (const init of initializers) init.call(this);
    }

    // RPC 方法形参名即 args 键名；严禁使用默认值、解构或剩余参数，最后一个形参命名 signal。
    async getState(signal) { try { return await handlers.getState(); } catch (e) { throw toRemoteError(e); } }
    async saveSettings(patch, signal) { try { return await handlers.saveSettings(patch); } catch (e) { throw toRemoteError(e); } }
    async testConnection(serverUrl, joinCode, signal) { try { return await handlers.testConnection(serverUrl, joinCode, signal); } catch (e) { throw toRemoteError(e); } }
    async startAuthorization(joinCode, signal) { try { return await handlers.startAuthorization(joinCode, signal); } catch (e) { throw toRemoteError(e); } }
    async pollAuthorization(requestId, signal) { try { return await handlers.pollAuthorization(requestId); } catch (e) { throw toRemoteError(e); } }
    async cancelAuthorization(requestId, signal) { try { return await handlers.cancelAuthorization(requestId); } catch (e) { throw toRemoteError(e); } }
    async setActiveAccount(accountId, signal) { try { return await handlers.setActiveAccount(accountId); } catch (e) { throw toRemoteError(e); } }
    async disconnectAccount(accountId, signal) { try { return await handlers.disconnectAccount(accountId); } catch (e) { throw toRemoteError(e); } }

    async getRuntimeStatus(signal) { try { return await handlers.getRuntimeStatus(signal); } catch (e) { throw toRemoteError(e); } }
    async installBinaries(signal) { try { return await handlers.installBinaries(signal); } catch (e) { throw toRemoteError(e); } }
    async downloadModels(signal) { try { return await handlers.downloadModels(signal); } catch (e) { throw toRemoteError(e); } }
    async checkPermissions(signal) { try { return await handlers.checkPermissions(signal); } catch (e) { throw toRemoteError(e); } }
    async requestPermission(kind, signal) { try { return await handlers.requestPermission(kind, signal); } catch (e) { throw toRemoteError(e); } }
    async openPrivacySettings(kind, signal) { try { return await handlers.openPrivacySettings(kind); } catch (e) { throw toRemoteError(e); } }
    async detectMeetings(signal) { try { return await handlers.detectMeetings(signal); } catch (e) { throw toRemoteError(e); } }

    async getLiveSnapshot(signal) { try { return await handlers.getLiveSnapshot(); } catch (e) { throw toRemoteError(e); } }
    async startRecording(options, signal) { try { return await handlers.startRecording(options, signal); } catch (e) { throw toRemoteError(e); } }
    async controlRecording(command, signal) { try { return await handlers.controlRecording(command); } catch (e) { throw toRemoteError(e); } }

    async listMeetings(query, signal) { try { return await handlers.listMeetings(query); } catch (e) { throw toRemoteError(e); } }
    async getMeetingDetail(meetingId, signal) { try { return await handlers.getMeetingDetail(meetingId); } catch (e) { throw toRemoteError(e); } }
    async getTranscriptPage(meetingId, offset, limit, speakerId, keyword, signal) { try { return await handlers.getTranscriptPage(meetingId, offset, limit, speakerId, keyword); } catch (e) { throw toRemoteError(e); } }
    async getPlaybackInfo(meetingId, signal) { try { return await handlers.getPlaybackInfo(meetingId); } catch (e) { throw toRemoteError(e); } }
    async getAudioSlice(meetingId, startMs, durationMs, signal) { try { return await handlers.getAudioSlice(meetingId, startMs, durationMs); } catch (e) { throw toRemoteError(e); } }
    async listDirectory(refresh, signal) { try { return await handlers.listDirectory(refresh, signal); } catch (e) { throw toRemoteError(e); } }
    async renameSpeaker(meetingId, speakerId, personId, label, rememberVoice, signal) { try { return await handlers.renameSpeaker(meetingId, speakerId, personId, label, rememberVoice, signal); } catch (e) { throw toRemoteError(e); } }
    async rediarizeMeeting(meetingId, scene, speakers, signal) { try { return await handlers.rediarizeMeeting(meetingId, scene, speakers, signal); } catch (e) { throw toRemoteError(e); } }
    async regenerateMinutes(meetingId, signal) { try { return await handlers.regenerateMinutes(meetingId, signal); } catch (e) { throw toRemoteError(e); } }
    async retryMeeting(meetingId, signal) { try { return await handlers.retryMeeting(meetingId, signal); } catch (e) { throw toRemoteError(e); } }
    async dismissJob(meetingId, signal) { try { return await handlers.dismissJob(meetingId); } catch (e) { throw toRemoteError(e); } }

    async confirmPushTodos(draftId, editedTodos, signal) { try { return await handlers.confirmPushTodos(draftId, editedTodos, signal); } catch (e) { throw toRemoteError(e); } }
    async cancelTodoDraft(draftId, signal) { try { return await handlers.cancelTodoDraft(draftId); } catch (e) { throw toRemoteError(e); } }
    async setKnowledgeSync(meetingId, enabled, signal) { try { return await handlers.setKnowledgeSync(meetingId, enabled); } catch (e) { throw toRemoteError(e); } }
    async refreshKnowledgeStatus(meetingId, signal) { try { return await handlers.refreshKnowledgeStatus(meetingId); } catch (e) { throw toRemoteError(e); } }

    async listVoiceprints(signal) { try { return await handlers.listVoiceprints(signal); } catch (e) { throw toRemoteError(e); } }
    async askVoiceprintConsent(openId, meetingTitle, signal) { try { return await handlers.askVoiceprintConsent(openId, meetingTitle, signal); } catch (e) { throw toRemoteError(e); } }
    async deleteVoiceprint(openId, signal) { try { return await handlers.deleteVoiceprint(openId, signal); } catch (e) { throw toRemoteError(e); } }

    async listCompanies(signal) { try { return await handlers.listCompanies(signal); } catch (e) { throw toRemoteError(e); } }
    async addCompany(appId, appSecret, signal) { try { return await handlers.addCompany(appId, appSecret, signal); } catch (e) { throw toRemoteError(e); } }
    async checkCompany(companyId, signal) { try { return await handlers.checkCompany(companyId, signal); } catch (e) { throw toRemoteError(e); } }
    async replaceCompanySecret(companyId, appSecret, signal) { try { return await handlers.replaceCompanySecret(companyId, appSecret, signal); } catch (e) { throw toRemoteError(e); } }
    async toggleCompany(companyId, enabled, signal) { try { return await handlers.toggleCompany(companyId, enabled, signal); } catch (e) { throw toRemoteError(e); } }
  }

  // 无选项方法直接以二元装饰器调用 Remote(method, context)，严禁传 Remote({})。
  for (const methodName of RPC_METHOD_NAMES) {
    Remote(EchoMindService.prototype[methodName], {
      kind: 'method',
      name: methodName,
      static: false,
      private: false,
      addInitializer(init) {
        initializers.push(init);
      },
    });
  }

  ctx.plugin(EchoMindService);
  return { serviceClass: EchoMindService, handlers };
}
