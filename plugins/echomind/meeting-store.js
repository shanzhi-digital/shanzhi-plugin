import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { dateParts, dayLabel, timeOfDay } from './lib/minutes-engine.mjs';
import { validMeetingId } from './workspace-paths.js';

// 本地会议仓储（recordings/<meetingId>/meeting.json + transcript.json）与离线逐字稿检索。
// 与 EchoMind 桌面端磁盘格式 100% 兼容，支持跨工作区扫描与原子写入。

const DIRECTORY_TTL_MS = 12 * 3600 * 1000;
export const MAX_SEARCH_MATCHES = 30;
export const MAX_SEARCH_CHARS = 12_000;

function writeAtomicJson(filePath, value, mode = 0o644) {
  const tmp = `${filePath}.${randomUUID()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode });
  renameSync(tmp, filePath);
}

function parseTimestamp(iso) {
  if (typeof iso !== 'string' || !iso.trim()) return 0;
  const raw = iso.trim();
  const hasOffset = /(?:Z|[+-]\d{2}:?\d{2})$/u.test(raw);
  const ms = Date.parse(hasOffset ? raw : `${raw}+08:00`);
  return Number.isNaN(ms) ? 0 : ms;
}

export function defaultMeetingTitle(startedAt) {
  try {
    const d = dateParts(startedAt);
    return `新会议 ${d.month}月${d.day}日 ${String(d.hour).padStart(2, '0')}:${String(d.minute).padStart(2, '0')}`;
  } catch {
    return '新会议';
  }
}

export function isDefaultMeetingTitle(meeting) {
  if (!meeting || !meeting.title) return true;
  return meeting.title === defaultMeetingTitle(meeting.startedAt);
}

/** 构造飞书任务请求体（与 EchoMind desktop/src/lib/push.ts 保持一致）。 */
export function buildFeishuTaskPayload(todo, meeting, meOpenId, nameOf) {
  const segments = meeting?.transcript?.segments || [];
  const evidenceSet = new Set(Array.isArray(todo.evidence) ? todo.evidence : []);
  const quotes = segments
    .filter((s) => evidenceSet.has(s.id))
    .slice(0, 2)
    .map((s) => `“${s.text.length > 120 ? `${s.text.slice(0, 120)}…` : s.text}”`);

  const lines = [
    todo.detail || null,
    todo.external ? `对方：${nameOf(todo.ownerPersonId) || todo.ownerMention || '外部联系人'}` : null,
    `来自会议「${meeting.title}」· ${dayLabel(meeting.startedAt)} ${timeOfDay(meeting.startedAt)}`,
    quotes.length ? `会上原话：\n${quotes.join('\n')}` : null,
    '由 EchoMind 整理',
  ];

  return {
    title: todo.external ? `跟进：${todo.title}` : todo.title,
    description: lines.filter(Boolean).join('\n'),
    due: todo.due || null,
    assigneeId: todo.external || !todo.ownerPersonId ? meOpenId : todo.ownerPersonId,
  };
}

export function createMeetingStore({ paths, now = () => Date.now() } = {}) {
  function readJsonIfExists(filePath) {
    try {
      return JSON.parse(readFileSync(filePath, 'utf8'));
    } catch {
      return null;
    }
  }

  function loadMeetingFromDir(meetingId, dir, { includeTranscript = true } = {}) {
    const meeting = readJsonIfExists(join(dir, 'meeting.json'));
    if (!meeting || typeof meeting !== 'object') return null;
    const normalized = { ...meeting, id: meetingId };
    if (includeTranscript && !normalized.transcript) {
      const tr = readJsonIfExists(join(dir, 'transcript.json'));
      if (tr && typeof tr === 'object') normalized.transcript = tr;
    }
    return normalized;
  }

  function listAllMeetings({ workspaceDir = '', includeTranscript = false } = {}) {
    const seen = new Set();
    const list = [];
    for (const root of paths.listRecordingsRoots({ workspaceDir, onlyExisting: true })) {
      let entries;
      try {
        entries = readdirSync(root, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || !validMeetingId(entry.name) || seen.has(entry.name)) continue;
        const dir = join(root, entry.name);
        const meeting = loadMeetingFromDir(entry.name, dir, { includeTranscript });
        if (!meeting) continue;
        seen.add(entry.name);
        list.push(meeting);
      }
    }
    list.sort((a, b) => parseTimestamp(b.startedAt) - parseTimestamp(a.startedAt));
    return list;
  }

  function listMeetings({
    workspaceDir = '',
    keyword = '',
    status = '',
    source = '',
    fromDate = '',
    toDate = '',
    limit = 50,
  } = {}) {
    const kw = String(keyword || '').trim().toLowerCase();
    const fromMs = fromDate ? parseTimestamp(fromDate.length === 10 ? `${fromDate}T00:00:00+08:00` : fromDate) : 0;
    const toMs = toDate ? parseTimestamp(toDate.length === 10 ? `${toDate}T23:59:59+08:00` : toDate) : 0;
    const maxItems = Math.max(1, Math.min(200, Number(limit) || 50));

    const all = listAllMeetings({ workspaceDir, includeTranscript: false });
    const filtered = all.filter((m) => {
      if (status && m.status !== status) return false;
      if (source && m.source !== source) return false;
      const ts = parseTimestamp(m.startedAt);
      if (fromMs && ts < fromMs) return false;
      if (toMs && ts > toMs) return false;
      if (kw) {
        const hay = [
          m.id,
          m.title,
          m.minutes?.title,
          m.minutes?.overview,
          ...(m.minutes?.chapters || []).map((c) => `${c.title} ${c.summary}`),
          ...(m.todos || []).map((t) => `${t.title} ${t.ownerMention || ''}`),
        ]
          .filter(Boolean)
          .join('\n')
          .toLowerCase();
        if (!hay.includes(kw)) return false;
      }
      return true;
    });

    return {
      total: filtered.length,
      meetings: filtered.slice(0, maxItems),
    };
  }

  function getMeeting(meetingId, { workspaceDir = '', includeTranscript = true } = {}) {
    if (!validMeetingId(meetingId)) return null;
    const dir = paths.resolveMeetingDir(meetingId, { workspaceDir, mustExist: true });
    if (!dir) return null;
    return loadMeetingFromDir(meetingId, dir, { includeTranscript });
  }

  function saveMeeting(meeting, { workspaceDir = '' } = {}) {
    if (!meeting || !validMeetingId(meeting.id)) {
      throw new RangeError('保存会议失败：会议编号不合法。');
    }
    const dir = paths.resolveMeetingDir(meeting.id, { workspaceDir, mustExist: false });
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    // 同时登记其父目录到工作区索引，确保跨会话可检索。
    const parentRoot = join(dir, '..');
    paths.registerRecordingsRoot(parentRoot);
    writeAtomicJson(join(dir, 'meeting.json'), meeting);
    if (meeting.transcript && typeof meeting.transcript === 'object') {
      writeAtomicJson(join(dir, 'transcript.json'), meeting.transcript);
    }
    return meeting;
  }

  function patchMeeting(meetingId, patch, { workspaceDir = '' } = {}) {
    const existing = getMeeting(meetingId, { workspaceDir, includeTranscript: true });
    if (!existing) return null;
    const updated = { ...existing, ...patch, id: meetingId };
    return saveMeeting(updated, { workspaceDir });
  }

  function ensureMeetingSkeleton({ meetingId, outDir, title, source, startedAt, durationMs = 0, recorderId = '' }) {
    const existing = getMeeting(meetingId, { includeTranscript: true });
    if (existing) return existing;
    const meeting = {
      id: meetingId,
      title: String(title || '').trim() || defaultMeetingTitle(startedAt),
      source: source || 'other',
      startedAt: startedAt || new Date(now()).toISOString(),
      durationMs: Math.max(0, Number(durationMs) || 0),
      status: 'recording',
      recorderId: recorderId || '',
      participantIds: recorderId ? [recorderId] : [],
      todos: [],
      knowledge: { off: false },
    };
    mkdirSync(outDir, { recursive: true, mode: 0o755 });
    writeAtomicJson(join(outDir, 'meeting.json'), meeting);
    paths.registerRecordingsRoot(join(outDir, '..'));
    return meeting;
  }

  function renameSpeaker(meetingId, speakerId, { personId = null, label = '', source = 'manual' } = {}) {
    const meeting = getMeeting(meetingId, { includeTranscript: true });
    if (!meeting || !meeting.transcript) return null;
    let found = false;
    const speakers = (meeting.transcript.speakers || []).map((sp) => {
      if (sp.id !== speakerId) return sp;
      found = true;
      return {
        ...sp,
        personId: personId || null,
        label: String(label || '').trim() || sp.label,
        source,
      };
    });
    if (!found) return null;
    const nextTranscript = { ...meeting.transcript, speakers };
    const participantIds = personId
      ? [...new Set([...(meeting.participantIds || []), personId])]
      : (meeting.participantIds || []);
    return saveMeeting({ ...meeting, participantIds, transcript: nextTranscript });
  }

  /** 前端右侧栏分页读逐字稿（不进模型上下文）。 */
  function getTranscriptPage(meetingId, { offset = 0, limit = 100, speakerId = '', keyword = '' } = {}) {
    const meeting = getMeeting(meetingId, { includeTranscript: true });
    if (!meeting?.transcript) return null;
    const kw = String(keyword || '').trim().toLowerCase();
    const allSegments = Array.isArray(meeting.transcript.segments) ? meeting.transcript.segments : [];
    const filtered = allSegments.filter((seg) => {
      if (speakerId && seg.speakerId !== speakerId) return false;
      if (kw && !String(seg.text || '').toLowerCase().includes(kw)) return false;
      return true;
    });
    const safeOffset = Math.max(0, Number(offset) || 0);
    const safeLimit = Math.max(1, Math.min(300, Number(limit) || 100));
    const slice = filtered.slice(safeOffset, safeOffset + safeLimit);
    return {
      meetingId,
      scene: meeting.transcript.scene || 'online',
      speakers: meeting.transcript.speakers || [],
      total: filtered.length,
      offset: safeOffset,
      hasMore: safeOffset + slice.length < filtered.length,
      nextOffset: safeOffset + slice.length < filtered.length ? safeOffset + slice.length : null,
      segments: slice,
    };
  }

  /**
   * 面向模型工具的本地离线逐字稿证据检索：
   * 仅返回命中的局部片段（含前后 1 句上下文），严格限制条数与总字数，绝不吐出整场会议全文。
   */
  function searchTranscript({
    meetingId = '',
    keyword = '',
    speakerName = '',
    startMs = null,
    endMs = null,
    limit = 15,
    maxChars = MAX_SEARCH_CHARS,
    workspaceDir = '',
    people = [],
  } = {}) {
    const kw = String(keyword || '').trim().toLowerCase();
    const spFilter = String(speakerName || '').trim().toLowerCase();
    const maxHits = Math.max(1, Math.min(MAX_SEARCH_MATCHES, Number(limit) || 15));
    const charBudget = Math.max(1000, Math.min(MAX_SEARCH_CHARS, Number(maxChars) || MAX_SEARCH_CHARS));
    const personById = new Map((Array.isArray(people) ? people : []).map((p) => [p.id, p.name]));

    const targets = meetingId
      ? [getMeeting(meetingId, { workspaceDir, includeTranscript: true })].filter(Boolean)
      : listAllMeetings({ workspaceDir, includeTranscript: true });

    const hits = [];
    let usedChars = 0;
    let truncated = false;

    for (const meeting of targets) {
      const tr = meeting.transcript;
      if (!tr || !Array.isArray(tr.segments) || tr.segments.length === 0) continue;
      const speakerMap = new Map(
        (tr.speakers || []).map((sp) => {
          const resolvedName = (sp.personId && personById.get(sp.personId)) || sp.label || sp.id;
          return [sp.id, { ...sp, displayName: resolvedName }];
        }),
      );
      const segments = tr.segments;
      for (let i = 0; i < segments.length; i += 1) {
        const seg = segments[i];
        if (startMs != null && Number.isFinite(Number(startMs)) && seg.end < Number(startMs)) continue;
        if (endMs != null && Number.isFinite(Number(endMs)) && seg.start > Number(endMs)) continue;
        const sp = speakerMap.get(seg.speakerId);
        const displayName = sp?.displayName || seg.speakerId;
        if (spFilter && !displayName.toLowerCase().includes(spFilter) && !seg.speakerId.toLowerCase().includes(spFilter)) {
          continue;
        }
        const text = String(seg.text || '');
        if (kw && !text.toLowerCase().includes(kw)) continue;

        const prev = i > 0 ? segments[i - 1] : null;
        const next = i + 1 < segments.length ? segments[i + 1] : null;
        const hit = {
          meetingId: meeting.id,
          meetingTitle: meeting.title,
          startedAt: meeting.startedAt,
          segmentId: seg.id,
          speakerId: seg.speakerId,
          speakerName: displayName,
          startMs: seg.start,
          endMs: seg.end,
          text,
          contextBefore: prev ? `${speakerMap.get(prev.speakerId)?.displayName || prev.speakerId}：${prev.text}` : null,
          contextAfter: next ? `${speakerMap.get(next.speakerId)?.displayName || next.speakerId}：${next.text}` : null,
        };
        const cost = text.length + (hit.contextBefore?.length || 0) + (hit.contextAfter?.length || 0) + 40;
        if (hits.length >= maxHits || usedChars + cost > charBudget) {
          truncated = true;
          break;
        }
        hits.push(hit);
        usedChars += cost;
      }
      if (truncated) break;
    }

    return {
      totalReturned: hits.length,
      truncated,
      hits,
    };
  }

  function loadDirectoryCache({ allowStale = false } = {}) {
    const cached = readJsonIfExists(paths.directoryCachePath);
    if (!cached || !Array.isArray(cached.people)) return null;
    const ageMs = now() - (Number(cached.fetchedAt) || 0) * 1000;
    if (!allowStale && ageMs > DIRECTORY_TTL_MS) return null;
    return {
      fetchedAt: Number(cached.fetchedAt) || 0,
      stale: ageMs > DIRECTORY_TTL_MS,
      people: cached.people,
    };
  }

  function saveDirectoryCache(people) {
    paths.ensureDir(paths.dataRoot);
    writeAtomicJson(paths.directoryCachePath, {
      fetchedAt: Math.floor(now() / 1000),
      people: Array.isArray(people) ? people : [],
    }, 0o600);
  }

  function countMeetings({ workspaceDir = '' } = {}) {
    return listAllMeetings({ workspaceDir, includeTranscript: false }).length;
  }

  function hasLocalAudio(meetingId) {
    const dir = paths.resolveMeetingDir(meetingId, { mustExist: true });
    if (!dir) return false;
    return existsSync(join(dir, 'manifest.json')) || existsSync(join(dir, 'mic-0001.wav'));
  }

  return {
    listAllMeetings,
    listMeetings,
    getMeeting,
    saveMeeting,
    patchMeeting,
    ensureMeetingSkeleton,
    renameSpeaker,
    getTranscriptPage,
    searchTranscript,
    loadDirectoryCache,
    saveDirectoryCache,
    countMeetings,
    hasLocalAudio,
  };
}
