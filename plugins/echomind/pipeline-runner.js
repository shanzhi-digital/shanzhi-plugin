import { DeepSeekProvider, runPipeline } from './lib/minutes-engine.mjs';
import { ApiError, defaultApiClient, safeErrorMessage } from './api-client.js';
import { ModelsMissingError } from './transcriber-manager.js';
import { isDefaultMeetingTitle } from './meeting-store.js';

// 录后全自动处理流水线（完整移植自 apps/desktop/src/lib/process.ts）：
// 本机转写（VAD / 说话人分离 / SenseVoice）→ 声纹自动认人 → 通讯录 & 飞书日历参会人 →
// DeepSeek 确定性纪要与待办提取（@echomind/minutes-engine）→ 落盘待确认 → 触发知识库同步。

export const STAGE_LABEL = Object.freeze({
  models: '等待下载本机语音模型（约 200 MB）',
  prepare: '正在读取录音',
  speech: '正在找出说话的片段',
  speakers: '正在区分说话人',
  text: '正在把语音转成文字',
  voices: '正在用声纹认出说话人',
  attendees: '正在从飞书日历找参会人',
  chapters: 'DeepSeek 正在划分议题',
  minutes: 'DeepSeek 正在写纪要',
  todos: 'DeepSeek 正在找待办',
});

function overallProgressFor(step, stage, p) {
  const clamped = Math.max(0, Math.min(1, Number(p) || 0));
  if (step === 'models') return 0;
  if (step === 'transcribe') {
    if (stage === 'prepare') return 0.02;
    if (stage === 'speech') return 0.02 + clamped * 0.05;
    if (stage === 'speakers') return 0.07 + clamped * 0.25;
    if (stage === 'text') return 0.32 + clamped * 0.43;
    if (stage === 'voices') return 0.77;
  }
  if (step === 'minutes') {
    if (stage === 'attendees') return 0.80;
    if (stage === 'chapters') return 0.82 + clamped * 0.06;
    if (stage === 'minutes') return 0.88 + clamped * 0.06;
    if (stage === 'todos') return 0.94 + clamped * 0.06;
  }
  return clamped;
}

function claimMicSpeaker(transcript, meOpenId) {
  if (!transcript || !Array.isArray(transcript.speakers) || !meOpenId) return transcript;
  return {
    ...transcript,
    speakers: transcript.speakers.map((s) =>
      s.track === 'mic' && s.source === 'self' && !s.personId ? { ...s, personId: meOpenId } : s,
    ),
  };
}

function applyVoiceprintMatches(transcript, matches, people) {
  if (!transcript || !Array.isArray(matches) || matches.length === 0) return transcript;
  const knownIds = new Set((people || []).map((p) => p.id));
  const taken = new Set((transcript.speakers || []).map((s) => s.personId).filter(Boolean));
  const speakers = (transcript.speakers || []).map((s) => {
    const hit = matches.find((m) => m.speakerId === s.id);
    if (s.personId || !hit || taken.has(hit.openId) || (knownIds.size > 0 && !knownIds.has(hit.openId))) {
      return s;
    }
    taken.add(hit.openId);
    return { ...s, personId: hit.openId, source: 'voiceprint', confidence: hit.score };
  });
  return { ...transcript, speakers };
}

export function createPipelineRunner({
  accounts,
  meetingStore,
  transcriberManager,
  voiceprintManager,
  knowledgeSync,
  paths,
  apiClient = defaultApiClient,
  createProvider = null,
  onJobChange = () => {},
  onMeetingUpdated = () => {},
  now = () => Date.now(),
} = {}) {
  const jobs = new Map();
  const running = new Set();

  function setJob(meetingId, job) {
    if (!job) jobs.delete(meetingId);
    else {
      jobs.set(meetingId, {
        meetingId,
        step: job.step,
        stage: job.stage || job.step,
        progress: Number(job.progress) || 0,
        overallProgress: overallProgressFor(job.step, job.stage || job.step, job.progress),
        label: STAGE_LABEL[job.stage || job.step] || '正在处理会议',
        ...(job.error ? { error: job.error } : {}),
      });
    }
    onJobChange(listJobs());
  }

  function listJobs() {
    return [...jobs.values()];
  }

  async function loadDirectory(forceRefresh = false, signal) {
    const cached = !forceRefresh ? meetingStore.loadDirectoryCache({ allowStale: false }) : null;
    if (cached) return cached.people;
    try {
      const res = await accounts.runBackend((cfg) => apiClient.getDirectory(cfg, { refresh: forceRefresh }, { signal }));
      if (res.ok && Array.isArray(res.value)) {
        meetingStore.saveDirectoryCache(res.value);
        return res.value;
      }
    } catch {
      // Offline fallback below.
    }
    const stale = meetingStore.loadDirectoryCache({ allowStale: true });
    return stale?.people || [];
  }

  async function lookupCalendarAttendees(meeting, signal) {
    if (!meeting?.startedAt) return null;
    const startMs = Date.parse(meeting.startedAt);
    if (Number.isNaN(startMs)) return null;
    const endIso = new Date(startMs + Math.max(60_000, Number(meeting.durationMs) || 0)).toISOString();
    try {
      const res = await accounts.runBackend((cfg) =>
        apiClient.getCalendarAttendees(cfg, { start: meeting.startedAt, end: endIso }, { signal }),
      );
      if (!res.ok || !res.value) return null;
      return {
        eventTitle: res.value.eventTitle || '',
        participantIds: [
          ...new Set([
            ...(meeting.recorderId ? [meeting.recorderId] : []),
            ...(meeting.participantIds || []),
            ...(Array.isArray(res.value.attendeeIds) ? res.value.attendeeIds : []),
          ]),
        ],
      };
    } catch {
      return null;
    }
  }

  function buildProxiedProvider(cfg, model) {
    if (typeof createProvider === 'function') {
      return createProvider({ cfg, model, apiClient });
    }
    const proxiedFetch = async (_url, init) => {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : (init?.body || {});
      const reply = await apiClient.proxyLlmChat(cfg, body, { signal: init?.signal });
      return new Response(reply.body, {
        status: reply.status,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      });
    };
    return new DeepSeekProvider({
      apiKey: 'proxied-by-echomind-server',
      model: model || 'deepseek-flash',
      fetch: proxiedFetch,
    });
  }

  async function run(meetingId, { hints = null, regenerateOnly = false, signal } = {}) {
    if (running.has(meetingId)) return meetingStore.getMeeting(meetingId, { includeTranscript: true });
    const before = meetingStore.getMeeting(meetingId, { includeTranscript: true });
    if (!before) {
      throw new ApiError('找不到指定的会议记录。', { code: 'NOT_FOUND' });
    }
    running.add(meetingId);
    let step = 'transcribe';
    let transcribed = false;

    try {
      let meeting = meetingStore.patchMeeting(meetingId, { status: 'transcribing' }) || before;
      onMeetingUpdated(meeting);

      const activeState = await accounts.getActiveBackend();
      const meOpenId = activeState.ok ? activeState.account.openId : '';
      if (meOpenId && !meeting.recorderId) {
        meeting = meetingStore.patchMeeting(meetingId, {
          recorderId: meOpenId,
          participantIds: [...new Set([meOpenId, ...(meeting.participantIds || [])])],
        }) || meeting;
      }

      const needTranscribe = !regenerateOnly && (!meeting.transcript?.segments?.length || Boolean(hints));
      if (needTranscribe) {
        const models = await transcriberManager.checkModels(signal);
        if (!models?.ready) {
          setJob(meetingId, { step: 'models', stage: 'models', progress: 0 });
          meeting = meetingStore.patchMeeting(meetingId, { status: before.minutes ? before.status : 'failed' }) || meeting;
          return meeting;
        }
        setJob(meetingId, { step: 'transcribe', stage: 'prepare', progress: 0 });
        const dir = paths.resolveMeetingDir(meetingId, { mustExist: true });
        let transcript = await transcriberManager.transcribe(meetingId, dir, {
          scene: hints?.scene,
          speakers: hints?.speakers,
          signal,
          onProgress: ({ stage, progress }) => setJob(meetingId, { step: 'transcribe', stage, progress }),
        });
        transcript = claimMicSpeaker(transcript, meOpenId);

        const people = await loadDirectory(false, signal);
        if (activeState.ok && voiceprintManager) {
          setJob(meetingId, { step: 'transcribe', stage: 'voices', progress: 0.5 });
          try {
            const matches = await voiceprintManager.matchMeetingVoices(meetingId, { signal });
            transcript = applyVoiceprintMatches(transcript, matches, people);
          } catch {
            // Best-effort voiceprint recognition.
          }
        }
        meeting = meetingStore.saveMeeting({ ...meeting, transcript });
        transcribed = true;
      }

      if (!meeting.transcript?.segments?.length) {
        throw new ApiError('录音里没有识别到说话声。请确认麦克风与系统录音权限都已开启后再录一次。', {
          code: 'EMPTY_TRANSCRIPT',
        });
      }

      step = 'minutes';
      const backend = await accounts.getActiveBackend();
      if (!backend.ok) {
        throw new ApiError(backend.authRequired.message, { code: 'UNAUTHORIZED' });
      }

      const people = await loadDirectory(false, signal);
      setJob(meetingId, { step: 'minutes', stage: 'attendees', progress: 0.3 });
      const calendar = await lookupCalendarAttendees(meeting, signal);
      const titled = !isDefaultMeetingTitle(meeting) ? meeting.title : (calendar?.eventTitle || '');
      if (calendar) {
        meeting = meetingStore.patchMeeting(meetingId, {
          participantIds: calendar.participantIds,
          ...(titled ? { title: titled } : {}),
        }) || meeting;
      }

      const llmRes = await accounts.runBackend((cfg) => apiClient.getLlmStatus(cfg, { signal }));
      if (!llmRes.ok) {
        throw new ApiError(llmRes.authRequired.message, { code: 'UNAUTHORIZED' });
      }
      if (!llmRes.value?.configured) {
        throw new ApiError('EchoMind 服务端尚未配置 DeepSeek 模型密钥，请联系管理员。', { code: 'LLM_NOT_CONFIGURED' });
      }

      const provider = buildProxiedProvider(backend.cfg, llmRes.value.model);
      let doneSteps = 0;
      const result = await runPipeline(meeting, {
        provider,
        directory: people,
        signal,
        onProgress: (stage, state) => {
          if (state === 'done') doneSteps += 1;
          setJob(meetingId, { step: 'minutes', stage, progress: doneSteps / 3 });
        },
      });

      const batch = now().toString(36);
      const todos = (result.todos || []).map((t) => ({
        ...t,
        id: `${meetingId}.${batch}.${t.id}`,
      }));

      const finalTitle = titled || result.minutes?.title || meeting.title;
      meeting = meetingStore.saveMeeting({
        ...meeting,
        title: finalTitle,
        status: todos.length > 0 ? 'review' : 'ready',
        minutes: result.minutes,
        todos,
      });

      setJob(meetingId, null);
      onMeetingUpdated(meeting);
      if (knowledgeSync) knowledgeSync.scheduleSync(meetingId);
      return meeting;
    } catch (error) {
      if (error instanceof ModelsMissingError) {
        setJob(meetingId, { step: 'models', stage: 'models', progress: 0 });
        return meetingStore.getMeeting(meetingId, { includeTranscript: true });
      }
      const msg = safeErrorMessage(error, error?.message || '处理会议失败，请重试。');
      if (before.minutes) {
        const restored = meetingStore.patchMeeting(meetingId, { status: before.status }) || before;
        setJob(meetingId, null);
        onMeetingUpdated(restored);
        throw new ApiError(
          transcribed ? `说话人已重新区分，但纪要更新失败：${msg}` : msg,
          { code: error?.code || 'PIPELINE_FAILED' },
        );
      }
      const failed = meetingStore.patchMeeting(meetingId, { status: 'failed' });
      setJob(meetingId, { step, stage: step, progress: 0, error: msg });
      if (failed) onMeetingUpdated(failed);
      throw error;
    } finally {
      running.delete(meetingId);
    }
  }

  function dismissJob(meetingId) {
    if (!meetingId || !jobs.has(meetingId)) return false;
    jobs.delete(meetingId);
    onJobChange(listJobs());
    return true;
  }

  function resumeWaitingModelsJobs() {
    const waiting = listJobs().filter((j) => j.step === 'models').map((j) => j.meetingId);
    for (const id of waiting) {
      setJob(id, null);
      void run(id).catch(() => {});
    }
    return waiting;
  }

  return {
    listJobs,
    getJob: (meetingId) => jobs.get(meetingId) || null,
    dismissJob,
    resumeWaitingModelsJobs,
    loadDirectory,
    start: (meetingId, opts) => run(meetingId, opts),
    retry: (meetingId, opts) => {
      setJob(meetingId, null);
      return run(meetingId, opts);
    },
    rediarize: (meetingId, hints, opts = {}) => {
      setJob(meetingId, null);
      return run(meetingId, { ...opts, hints });
    },
    regenerateMinutes: (meetingId, opts = {}) => {
      setJob(meetingId, null);
      return run(meetingId, { ...opts, regenerateOnly: true });
    },
  };
}
