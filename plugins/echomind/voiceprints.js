import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { ApiError, defaultApiClient } from './api-client.js';

// 声纹隐私同意与后台续传管理（完整移植自 apps/desktop/src-tauri/src/voiceprints.rs）：
// - 声纹特征向量（192 维）只在宿主 Node 内存与 EchoMind 服务端之间传输，不落盘、不回传前端或模型；
// - 给同事命名并勾选「记住声音」但对方尚未同意时，仅向同事发飞书同意卡片，并在 voice-pending.json
//   记录 { openId, meetingId, speakerId, namedBy, joinCode, since }（30 天过期）；
// - 每 5 分钟后台检查当前登录账户下的 pending 项：对方同意且该会议说话人仍叫该名字时再提取上传。

const PENDING_TTL_SECONDS = 30 * 24 * 3600;
const MIN_SAMPLE_SECONDS = 5.0;
const MIN_MATCH_SECONDS = 3.0;
const FLUSH_INTERVAL_MS = 5 * 60_000;
const OPEN_ID_PATTERN = /^ou_[0-9a-z]{1,60}$/iu;

function validateOpenId(openId) {
  const id = String(openId || '').trim();
  if (!OPEN_ID_PATTERN.test(id)) {
    throw new ApiError('通讯录里没有这个人（openId 格式无效）。', { code: 'INVALID_REQUEST' });
  }
  return id;
}

function stillNamed(meeting, speakerId, openId) {
  const speakers = meeting?.transcript?.speakers;
  if (!Array.isArray(speakers)) return false;
  return speakers.some((sp) => sp.id === speakerId && sp.personId === openId);
}

export function createVoiceprintManager({
  accounts,
  meetingStore,
  transcriberManager,
  paths,
  apiClient = defaultApiClient,
  nowSec = () => Math.floor(Date.now() / 1000),
  flushIntervalMs = FLUSH_INTERVAL_MS,
  enableBackgroundTimer = true,
} = {}) {
  let flushing = false;
  let timer = null;
  let disposed = false;

  function loadPending() {
    try {
      const parsed = JSON.parse(readFileSync(paths.voicePendingPath, 'utf8'));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function savePending(list) {
    if (!list || list.length === 0) {
      if (existsSync(paths.voicePendingPath)) {
        try { rmSync(paths.voicePendingPath, { force: true }); } catch {}
      }
      return;
    }
    paths.ensureDir(paths.dataRoot);
    const tmp = `${paths.voicePendingPath}.${randomUUID()}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(list, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, paths.voicePendingPath);
  }

  async function extractSpeakerVoice(meetingId, speakerId, signal) {
    const dir = paths.resolveMeetingDir(meetingId, { mustExist: true });
    if (!dir) throw new ApiError('找不到该会议的本地录音目录。', { code: 'NOT_FOUND' });
    const voices = await transcriberManager.extractVoices(dir, { signal });
    const hit = voices.find((v) => v.speakerId === speakerId);
    if (!hit || !Array.isArray(hit.vector)) {
      throw new ApiError('这位说话人在这场会里说得太少了，取不出声纹。', { code: 'TOO_SHORT' });
    }
    if ((Number(hit.seconds) || 0) < MIN_SAMPLE_SECONDS) {
      throw new ApiError('这位说话人干净发言不足 5 秒，无法存入声纹。', { code: 'TOO_SHORT' });
    }
    return hit;
  }

  async function matchMeetingVoices(meetingId, { signal } = {}) {
    const dir = paths.resolveMeetingDir(meetingId, { mustExist: true });
    if (!dir) return [];
    const rawVoices = await transcriberManager.extractVoices(dir, { signal });
    const eligible = rawVoices.filter(
      (v) => v && typeof v.speakerId === 'string' && Array.isArray(v.vector) && (Number(v.seconds) || 0) >= MIN_MATCH_SECONDS,
    );
    if (eligible.length === 0) return [];
    const res = await accounts.runBackend((cfg) => apiClient.matchVoiceprints(cfg, eligible, { signal }));
    if (!res.ok) return [];
    return Array.isArray(res.value?.matches) ? res.value.matches : [];
  }

  async function flushPending() {
    if (disposed || flushing) return;
    flushing = true;
    try {
      const pending = loadPending();
      if (pending.length === 0) return;
      const active = await accounts.getActiveBackend();
      if (!active.ok) return;
      const meOpenId = active.account.openId;
      const meJoinCode = active.account.joinCode || '';

      if (!pending.some((p) => p.namedBy === meOpenId && (p.joinCode || '') === meJoinCode)) {
        return;
      }

      const listRes = await accounts.runBackend((cfg) => apiClient.listVoiceprints(cfg));
      if (!listRes.ok) return;
      const entries = Array.isArray(listRes.value?.voiceprints) ? listRes.value.voiceprints : [];
      const statusMap = new Map(entries.map((e) => [e.openId, e.status]));

      const currentSec = nowSec();
      const remaining = [];
      for (const item of pending) {
        const fresh = (Number(item.since) || 0) + PENDING_TTL_SECONDS > currentSec;
        if (item.namedBy !== meOpenId || (item.joinCode || '') !== meJoinCode) {
          if (fresh) remaining.push(item);
          continue;
        }
        const st = statusMap.get(item.openId);
        if (st === 'agreed') {
          const meeting = meetingStore.getMeeting(item.meetingId, { includeTranscript: true });
          if (meeting && stillNamed(meeting, item.speakerId, item.openId)) {
            try {
              const voice = await extractSpeakerVoice(item.meetingId, item.speakerId);
              const sendRes = await accounts.runBackend((cfg) =>
                apiClient.addVoiceprintSample(cfg, item.openId, {
                  vector: voice.vector,
                  seconds: voice.seconds,
                }),
              );
              if (!sendRes.ok) remaining.push(item);
            } catch (error) {
              if (error?.retryable) remaining.push(item);
              // Non-retryable refusal (e.g. not_same_person / too_short): drop.
            }
          }
          continue;
        }
        if (st === 'declined') {
          continue;
        }
        if (fresh) remaining.push(item);
      }
      savePending(remaining);
    } finally {
      flushing = false;
    }
  }

  async function listVoiceprints(signal) {
    const res = await accounts.runBackend((cfg) => apiClient.listVoiceprints(cfg, { signal }));
    if (res.ok) {
      void flushPending().catch(() => {});
    }
    return res;
  }

  async function askConsent(openId, meetingTitle, signal) {
    const id = validateOpenId(openId);
    return accounts.runBackend((cfg) => apiClient.askVoiceprintConsent(cfg, id, meetingTitle || null, { signal }));
  }

  async function deleteVoiceprint(openId, signal) {
    const id = validateOpenId(openId);
    return accounts.runBackend(async (cfg) => {
      await apiClient.deleteVoiceprint(cfg, id, { signal });
      const next = loadPending().filter((p) => p.openId !== id);
      savePending(next);
      return { ok: true };
    });
  }

  async function rememberSpeakerVoice({ meetingId, speakerId, openId, meetingTitle = '' }, signal) {
    const targetOpenId = validateOpenId(openId);
    return accounts.runBackend(async (cfg, account) => {
      // 给自己命名并勾选「记住我的声音」视同本人同意，直接提取上传。
      if (targetOpenId === account.openId) {
        const voice = await extractSpeakerVoice(meetingId, speakerId, signal);
        const vp = await apiClient.addVoiceprintSample(cfg, targetOpenId, {
          vector: voice.vector,
          seconds: voice.seconds,
        }, { signal });
        return { status: 'saved', voiceprint: vp };
      }

      const listReply = await apiClient.listVoiceprints(cfg, { signal });
      const existing = (listReply?.voiceprints || []).find((v) => v.openId === targetOpenId);

      if (existing?.status === 'declined') {
        return { status: 'declined', voiceprint: existing };
      }
      if (existing?.status === 'agreed') {
        const voice = await extractSpeakerVoice(meetingId, speakerId, signal);
        const vp = await apiClient.addVoiceprintSample(cfg, targetOpenId, {
          vector: voice.vector,
          seconds: voice.seconds,
        }, { signal });
        return { status: 'saved', voiceprint: vp };
      }

      // 校验这段声音够长，再发同意卡片（只记录指针，不存声音特征）。
      await extractSpeakerVoice(meetingId, speakerId, signal);
      let askedEntry = existing || null;
      let status = 'waiting';
      if (!existing) {
        askedEntry = await apiClient.askVoiceprintConsent(cfg, targetOpenId, meetingTitle || null, { signal });
        status = 'asked';
      }
      const pending = loadPending().filter(
        (p) => !(p.openId === targetOpenId && p.meetingId === meetingId && p.speakerId === speakerId),
      );
      pending.push({
        openId: targetOpenId,
        meetingId,
        speakerId,
        namedBy: account.openId,
        joinCode: account.joinCode || '',
        since: nowSec(),
      });
      savePending(pending);
      return { status, voiceprint: askedEntry };
    });
  }

  if (enableBackgroundTimer && flushIntervalMs > 0) {
    timer = setInterval(() => {
      void flushPending().catch(() => {});
    }, flushIntervalMs);
    timer.unref?.();
  }

  function dispose() {
    disposed = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return {
    matchMeetingVoices,
    listVoiceprints,
    askConsent,
    deleteVoiceprint,
    rememberSpeakerVoice,
    flushPending,
    dispose,
  };
}
