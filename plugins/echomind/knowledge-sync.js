import { createHash } from 'node:crypto';
import { defaultApiClient, safeErrorMessage } from './api-client.js';

// DataHub「会议纪要」知识库自动同步器（完整移植自 apps/desktop/src/lib/knowledge.ts）：
// - 只上传纪要正文与已确认（非 draft）待办，绝不上传逐字稿、原话出处 evidence 与待办完成态；
// - 用规范化 JSON 的 SHA-256 指纹写入 meeting.knowledge.sentHash，内容未变不重复上传；
// - 单会议串行队列（关闭撤回绝不超车上传），编辑防抖 3 秒，失败 5 分钟后台自动重试。

const SENDABLE_STATUSES = new Set(['review', 'ready', 'pushed']);
const SEND_AFTER_MS = 3000;
const RETRY_EVERY_MS = 5 * 60_000;

const cut = (text, max) => {
  const s = String(text || '');
  return s.length > max ? s.slice(0, max) : s;
};

const extractPointTexts = (points) =>
  (Array.isArray(points) ? points : []).slice(0, 200).map((p) => cut(p?.text || '', 5000)).filter(Boolean);

export function buildMinutesUpload(meeting, todos, lookupPerson, signedInName = '') {
  const minutes = meeting?.minutes;
  if (!minutes) return null;
  const nameOf = (id) => (id ? String(lookupPerson(id)?.name || '').trim() || undefined : undefined);
  const participants = [...new Set((meeting.participantIds || []).map(nameOf).filter(Boolean))];
  const todoList = Array.isArray(todos) ? todos : (Array.isArray(meeting.todos) ? meeting.todos : []);

  return {
    title: cut(String(meeting.title || '').trim() || String(minutes.title || '').trim() || '会议纪要', 200),
    source: meeting.source || 'other',
    startedAt: meeting.startedAt,
    durationMs: Math.max(0, Number(meeting.durationMs) || 0),
    recorder: cut(nameOf(meeting.recorderId) || String(signedInName || '').trim(), 100),
    participants: participants.slice(0, 200).map((n) => cut(n, 100)),
    overview: cut(minutes.overview || '', 20_000),
    chapters: (minutes.chapters || []).slice(0, 200).map((c) => ({
      title: cut(c.title || '', 200),
      summary: cut(c.summary || '', 20_000),
    })),
    conclusions: extractPointTexts(minutes.conclusions),
    decisions: extractPointTexts(minutes.decisions),
    openQuestions: extractPointTexts(minutes.openQuestions),
    todos: todoList
      .filter((t) => t && t.status !== 'draft')
      .slice(0, 200)
      .map((t) => {
        const detail = String(t.detail || '').trim();
        const owner = nameOf(t.ownerPersonId) || (t.external ? String(t.ownerMention || '').trim() || undefined : undefined);
        return {
          title: cut(t.title || '', 500),
          ...(detail ? { detail: cut(detail, 5000) } : {}),
          owner: owner ? cut(owner, 100) : null,
          external: Boolean(t.external),
          due: t.due || null,
          dueText: t.dueText ? cut(t.dueText, 100) : null,
        };
      }),
  };
}

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function fingerprintUpload(upload) {
  return createHash('sha256').update(stableJson(upload), 'utf8').digest('hex');
}

export function createKnowledgeSync({
  accounts,
  meetingStore,
  apiClient = defaultApiClient,
  debounceMs = SEND_AFTER_MS,
  retryIntervalMs = RETRY_EVERY_MS,
  enableBackgroundTimer = true,
} = {}) {
  const statuses = new Map();
  const turns = new Map();
  const debounceTimers = new Map();
  let retryTimer = null;
  let disposed = false;

  function setStatus(meetingId, next) {
    statuses.set(meetingId, next);
  }

  function getStatus(meetingId) {
    return statuses.get(meetingId) || {};
  }

  function inTurn(meetingId, work) {
    const prev = turns.get(meetingId) || Promise.resolve();
    const next = prev.then(work, work);
    turns.set(meetingId, next);
    void next.finally(() => {
      if (turns.get(meetingId) === next) turns.delete(meetingId);
    });
    return next;
  }

  async function settleOne(meetingId) {
    if (disposed) return getStatus(meetingId);
    const meeting = meetingStore.getMeeting(meetingId, { includeTranscript: false });
    if (!meeting?.minutes || !SENDABLE_STATUSES.has(meeting.status)) return getStatus(meetingId);

    const flags = meeting.knowledge || { off: false };
    if (flags.off) {
      if (flags.sentHash) {
        return withdrawOne(meetingId);
      }
      return getStatus(meetingId);
    }

    const dirCache = meetingStore.loadDirectoryCache({ allowStale: true });
    const people = dirCache?.people || [];
    const lookup = (pid) => people.find((p) => p.id === pid);

    const res = await accounts.runBackend(async (cfg, account) => {
      const upload = buildMinutesUpload(meeting, meeting.todos, lookup, account?.name || '');
      if (!upload) return null;
      const hash = fingerprintUpload(upload);
      if (hash === flags.sentHash) {
        const cur = getStatus(meetingId);
        if (cur.error) setStatus(meetingId, { ...cur, error: undefined });
        return { skipped: true, sync: cur.sync || null };
      }
      const reply = await apiClient.putMeetingMinutes(cfg, meetingId, upload);
      const sync = reply?.sync || null;
      meetingStore.patchMeeting(meetingId, {
        knowledge: { off: false, sentHash: hash },
      });
      setStatus(meetingId, { sync });
      return { skipped: false, sync };
    });

    if (!res.ok) {
      setStatus(meetingId, { ...getStatus(meetingId), error: res.authRequired.message });
    }
    return getStatus(meetingId);
  }

  async function withdrawOne(meetingId) {
    const res = await accounts.runBackend(async (cfg) => {
      const reply = await apiClient.withdrawMeetingMinutes(cfg, meetingId);
      const sync = reply?.sync || { meetingId, state: 'removed' };
      meetingStore.patchMeeting(meetingId, {
        knowledge: { off: true },
      });
      setStatus(meetingId, { sync });
      return sync;
    });
    if (!res.ok) {
      setStatus(meetingId, { ...getStatus(meetingId), error: res.authRequired.message });
    }
    return getStatus(meetingId);
  }

  function scheduleSync(meetingId) {
    if (disposed) return;
    const old = debounceTimers.get(meetingId);
    if (old) clearTimeout(old);
    const timer = setTimeout(() => {
      debounceTimers.delete(meetingId);
      void syncMeeting(meetingId).catch(() => {});
    }, debounceMs);
    timer.unref?.();
    debounceTimers.set(meetingId, timer);
  }

  function syncMeeting(meetingId) {
    return inTurn(meetingId, async () => {
      try {
        return await settleOne(meetingId);
      } catch (error) {
        setStatus(meetingId, { ...getStatus(meetingId), error: safeErrorMessage(error, '没连上服务器，联网后会自动放进知识库。') });
        return getStatus(meetingId);
      }
    });
  }

  async function setKnowledgeOn(meetingId, on) {
    const meeting = meetingStore.getMeeting(meetingId, { includeTranscript: false });
    if (!meeting) return null;
    const prevHash = meeting.knowledge?.sentHash;
    meetingStore.patchMeeting(meetingId, {
      knowledge: prevHash ? { off: !on, sentHash: prevHash } : { off: !on },
    });
    setStatus(meetingId, { ...getStatus(meetingId), error: undefined });
    return inTurn(meetingId, async () => {
      try {
        if (on) return await settleOne(meetingId);
        return await withdrawOne(meetingId);
      } catch (error) {
        const fallback = on ? '没连上服务器，联网后会自动放进知识库。' : '没连上服务器，联网后会自动从知识库撤下。';
        setStatus(meetingId, { ...getStatus(meetingId), error: safeErrorMessage(error, fallback) });
        return getStatus(meetingId);
      }
    });
  }

  function refreshStatus(meetingId) {
    return inTurn(meetingId, async () => {
      try {
        const res = await accounts.runBackend(async (cfg) => {
          try {
            const reply = await apiClient.getMeetingMinutes(cfg, meetingId);
            return reply?.sync || null;
          } catch (error) {
            if (error?.status === 404 || error?.code === 'NOT_FOUND') return null;
            throw error;
          }
        });
        if (!res.ok) {
          setStatus(meetingId, { ...getStatus(meetingId), unseen: res.authRequired.message });
          return getStatus(meetingId);
        }
        setStatus(meetingId, { ...getStatus(meetingId), sync: res.value, unseen: undefined });
        return getStatus(meetingId);
      } catch (error) {
        setStatus(meetingId, { ...getStatus(meetingId), unseen: safeErrorMessage(error, '暂时查不到知识库状态。') });
        return getStatus(meetingId);
      }
    });
  }

  async function sendAll() {
    if (disposed) return;
    const meetings = meetingStore.listAllMeetings({ includeTranscript: false });
    for (const m of meetings) {
      if (disposed) break;
      if (m.minutes) {
        await syncMeeting(m.id);
      }
    }
  }

  if (enableBackgroundTimer && retryIntervalMs > 0) {
    retryTimer = setInterval(() => {
      void sendAll().catch(() => {});
    }, retryIntervalMs);
    retryTimer.unref?.();
  }

  function dispose() {
    disposed = true;
    if (retryTimer) {
      clearInterval(retryTimer);
      retryTimer = null;
    }
    for (const t of debounceTimers.values()) clearTimeout(t);
    debounceTimers.clear();
  }

  return {
    getStatus,
    scheduleSync,
    syncMeeting,
    setKnowledgeOn,
    refreshStatus,
    sendAll,
    dispose,
  };
}
