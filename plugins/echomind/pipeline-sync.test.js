import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockProvider } from './lib/minutes-engine.mjs';
import { createWorkspacePaths } from './workspace-paths.js';
import { createMeetingStore } from './meeting-store.js';
import { createKnowledgeSync } from './knowledge-sync.js';
import { createVoiceprintManager } from './voiceprints.js';
import { createPipelineRunner } from './pipeline-runner.js';

const dir = mkdtempSync(join(tmpdir(), 'echomind-pipe-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));

test('end-to-end pipeline runs transcribe -> voiceprints -> calendar -> bundled minutes-engine -> knowledge sync', async () => {
  const paths = createWorkspacePaths({ dataRoot: join(dir, 'data') });
  const meetingStore = createMeetingStore({ paths });
  const recDir = join(paths.resolveRecordingsDir({ ensure: true }), 'rec-e2e');
  mkdirSync(recDir, { recursive: true });
  writeFileSync(join(recDir, 'manifest.json'), JSON.stringify({ version: 1, status: 'stopped', segments: [] }));

  meetingStore.ensureMeetingSkeleton({
    meetingId: 'rec-e2e',
    outDir: recDir,
    title: '',
    source: 'tencent',
    startedAt: '2026-11-25T10:00:00+08:00',
    durationMs: 600_000,
    recorderId: 'ou_me',
  });

  const apiCalls = [];
  let vpStatus = 'asked';
  const apiClient = {
    async getDirectory() {
      return [
        { id: 'ou_me', name: '张三', feishuOpenId: 'ou_me', aliases: ['张总'], external: false },
        { id: 'ou_li', name: '李四', feishuOpenId: 'ou_li', aliases: ['小李'], external: false },
      ];
    },
    async getCalendarAttendees() {
      return { eventTitle: 'EchoMind 接入评审会', attendeeIds: ['ou_me', 'ou_li'] };
    },
    async getLlmStatus() {
      return { configured: true, model: 'deepseek-flash' };
    },
    async matchVoiceprints(_cfg, voices) {
      apiCalls.push({ op: 'matchVoiceprints', count: voices.length });
      return { matches: [{ speakerId: 'S2', openId: 'ou_li', score: 0.91 }] };
    },
    async listVoiceprints() {
      return { voiceprints: [{ openId: 'ou_li', status: vpStatus }] };
    },
    async askVoiceprintConsent(_cfg, openId) {
      apiCalls.push({ op: 'askConsent', openId });
      return { openId, status: 'asked' };
    },
    async addVoiceprintSample(_cfg, openId, sample) {
      apiCalls.push({ op: 'addSample', openId, seconds: sample.seconds });
      return { openId, status: 'agreed', samples: 1 };
    },
    async putMeetingMinutes(_cfg, meetingId, upload) {
      apiCalls.push({ op: 'putMinutes', meetingId, upload });
      return { sync: { meetingId, state: 'queued' } };
    },
    async withdrawMeetingMinutes(_cfg, meetingId) {
      apiCalls.push({ op: 'withdrawMinutes', meetingId });
      return { sync: { meetingId, state: 'removed' } };
    },
  };

  const accounts = {
    async getActiveBackend() {
      return {
        ok: true,
        cfg: { serverUrl: 'https://mock.local', token: 'tok' },
        account: { id: 'em_1', openId: 'ou_me', name: '张三', joinCode: 'SZ01', status: 'ok' },
      };
    },
    async runBackend(fn) {
      const active = await this.getActiveBackend();
      return { ok: true, value: await fn(active.cfg, active.account), account: active.account };
    },
  };

  const transcriberManager = {
    async checkModels() { return { ready: true }; },
    async transcribe(_id, _dir, opts) {
      opts?.onProgress?.({ stage: 'text', progress: 1 });
      return {
        meetingId: 'rec-e2e',
        language: 'zh',
        scene: 'online',
        speakers: [
          { id: 'S1', label: '我', track: 'mic', personId: null, source: 'self' },
          { id: 'S2', label: '说话人 2', track: 'system', personId: null, source: 'unknown' },
        ],
        segments: [
          { id: 'seg-0001', speakerId: 'S1', track: 'mic', start: 0, end: 5000, text: '今天我们敲定 EchoMind 接入 DSH 插件的排期。' },
          { id: 'seg-0002', speakerId: 'S2', track: 'system', start: 5500, end: 12000, text: '我来负责本周五前把双轨录音实机验证跑完。' },
        ],
      };
    },
    async extractVoices() {
      return [{ speakerId: 'S2', seconds: 8.5, vector: new Array(192).fill(0.05) }];
    },
  };

  const voiceprintManager = createVoiceprintManager({
    accounts,
    meetingStore,
    transcriberManager,
    paths,
    apiClient,
    enableBackgroundTimer: false,
  });

  const knowledgeSync = createKnowledgeSync({
    accounts,
    meetingStore,
    apiClient,
    debounceMs: 10,
    enableBackgroundTimer: false,
  });

  const mockLlmProvider = new MockProvider({
    chapters: [
      {
        chapters: [{ title: '排期确认', startSegmentId: 'seg-0001', endSegmentId: 'seg-0002', summary: '敲定接入排期与验证负责。' }],
      },
    ],
    minutes: [
      {
        title: 'EchoMind 接入评审会',
        overview: '确认了接入排期与本周五前的验证计划。',
        conclusions: [{ text: '本周五前完成双轨录音验证', evidence: ['seg-0002'] }],
        decisions: [{ text: '按插件形态接入 DSH', evidence: ['seg-0001'] }],
        openQuestions: [],
      },
    ],
    todos: [
      {
        todos: [
          {
            title: '完成双轨录音实机验证',
            detail: '验证 macOS 权限与封盘',
            ownerMention: '我',
            ownerSegmentId: 'seg-0002',
            dueText: '本周五前',
            evidence: ['seg-0002'],
          },
        ],
      },
    ],
  });

  const runner = createPipelineRunner({
    accounts,
    meetingStore,
    transcriberManager,
    voiceprintManager,
    knowledgeSync,
    paths,
    apiClient,
    createProvider: () => mockLlmProvider,
  });

  try {
    const meeting = await runner.start('rec-e2e');
    assert.equal(meeting.title, 'EchoMind 接入评审会');
    assert.equal(meeting.status, 'review');
    // S1 claimed as me; S2 auto-recognised via voiceprint as 李四
    assert.equal(meeting.transcript.speakers[0].personId, 'ou_me');
    assert.equal(meeting.transcript.speakers[1].personId, 'ou_li');
    assert.equal(meeting.transcript.speakers[1].source, 'voiceprint');
    // Todo resolved to 李四 (self-claimed on seg-0002) and Friday due date (2026-11-27)
    assert.equal(meeting.todos.length, 1);
    assert.equal(meeting.todos[0].ownerPersonId, 'ou_li');
    assert.equal(meeting.todos[0].due, '2026-11-27');

    // Sync to knowledge base (transcript & evidence must NEVER be uploaded)
    await knowledgeSync.syncMeeting('rec-e2e');
    const putCalls = apiCalls.filter((c) => c.op === 'putMinutes');
    assert.equal(putCalls.length, 1);
    assert.equal('transcript' in putCalls[0].upload, false);
    assert.deepEqual(putCalls[0].upload.todos, []); // draft todos excluded until confirmed

    // Re-sync unchanged content is a no-op (SHA-256 fingerprint match)
    await knowledgeSync.syncMeeting('rec-e2e');
    assert.equal(apiCalls.filter((c) => c.op === 'putMinutes').length, 1);

    // Turning off withdraws from knowledge base
    await knowledgeSync.setKnowledgeOn('rec-e2e', false);
    assert.equal(apiCalls.filter((c) => c.op === 'withdrawMinutes').length, 1);

    // Voiceprint pending consent -> once agreed, flushPending uploads sample
    const remRes = await voiceprintManager.rememberSpeakerVoice({ meetingId: 'rec-e2e', speakerId: 'S2', openId: 'ou_li' });
    assert.equal(remRes.ok, true);
    assert.equal(remRes.value.status, 'waiting');

    vpStatus = 'agreed';
    await voiceprintManager.flushPending();
    assert.equal(apiCalls.filter((c) => c.op === 'addSample' && c.openId === 'ou_li').length, 1);
  } finally {
    knowledgeSync.dispose();
    voiceprintManager.dispose();
  }
});
