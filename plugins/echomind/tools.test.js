import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupEchoMind } from './index.js';
import { assertLossless } from './assert-lossless.js';
import { AUTH_REQUIRED_KIND, MINUTES_CARD_KIND, TODO_DRAFT_KIND } from './event-projection.js';

const dir = mkdtempSync(join(tmpdir(), 'echomind-tools-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));

function createFakeHost() {
  const registeredTools = new Map();
  const promptSections = [];
  const remoteClasses = [];
  const ctx = {
    tools: {
      register(def) { registeredTools.set(def.name, def); },
    },
    systemPrompt: {
      section(name, content, opts) { promptSections.push({ name, content, opts }); },
    },
    get(svc) { return this[svc]; },
    plugin(cls) { remoteClasses.push(cls); },
    effect() {},
  };

  // Strict Typert mock that reproduces real host rejection of Remote({})
  class FakeTypertRemoteService {
    constructor(c, serviceName) { this.ctx = c; this.serviceName = serviceName; }
  }
  class FakeRemoteError extends Error {
    constructor(code, message) { super(message); this.code = code; }
  }
  function FakeRemote(targetOrOpts, context) {
    if (context === undefined) {
      const opts = targetOrOpts;
      if (!opts || (!opts.name && opts.mode !== 'stream' && !opts.resources)) {
        throw new TypeError('typert-protocol: Remote options require name, mode: "stream", or resources');
      }
      return (fn, ctxArg) => { ctxArg?.addInitializer?.(() => {}); return fn; };
    }
    context?.addInitializer?.(() => {});
    return targetOrOpts;
  }

  return {
    ctx,
    registeredTools,
    promptSections,
    remoteClasses,
    typert: { TypertRemoteService: FakeTypertRemoteService, Remote: FakeRemote, RemoteError: FakeRemoteError },
  };
}

test('registers exactly 8 tools, validates lossless JSON, enforces RPC-only todo push, and passes strict @Remote', async () => {
  const host = createFakeHost();
  const createdTasks = [];
  let failOnSecond = true;

  const apiClient = {
    async getDirectory() {
      return [
        { id: 'ou_1', name: '张三', department: '研发部', title: '工程师', feishuOpenId: 'ou_1', aliases: [], external: false },
        { id: 'ou_2', name: '李四', department: '产品部', title: '经理', feishuOpenId: 'ou_2', aliases: [], external: false },
      ];
    },
    async listVoiceprints() {
      return {
        voiceprints: [
          { openId: 'ou_1', status: 'agreed', enrolled: true, samples: 2, seconds: 60 },
          { openId: 'ou_2', status: 'asked', enrolled: false, samples: 0, seconds: 0 },
        ],
      };
    },
    async createFeishuTask(_cfg, task) {
      if (failOnSecond && createdTasks.length === 1) {
        throw new Error('feishu temp error');
      }
      const guid = `task_${createdTasks.length + 1}`;
      createdTasks.push({ guid, task });
      return { guid, url: `https://feishu.cn/task/${guid}` };
    },
    async putMeetingMinutes() { return { sync: { state: 'queued' } }; },
  };

  const dataRoot = join(dir, 'dsh-home');
  const inst = setupEchoMind(host.ctx, {
    dataRoot,
    apiClient,
    typert: host.typert,
    enableBackgroundTimers: false,
  });

  try {
    // 1. Exact 8 tools + TypertRemoteService registered without triggering Remote({}) error
    assert.equal(host.registeredTools.size, 8);
    assert.equal(host.remoteClasses.length, 1);
    assert.equal(host.promptSections.length, 1);

    // 2. Seed a local meeting with transcript & 2 draft todos
    const recDir = join(inst.paths.resolveRecordingsDir({ ensure: true }), 'rec-demo1');
    mkdirSync(recDir, { recursive: true });
    const segments = [];
    for (let i = 1; i <= 40; i += 1) {
      segments.push({
        id: `seg-${String(i).padStart(4, '0')}`,
        speakerId: 'S1',
        track: 'mic',
        start: i * 1000,
        end: i * 1000 + 800,
        text: `第 ${i} 条讨论关于项目回款与上线排期的详细内容。`.repeat(15),
      });
    }
    inst.meetingStore.saveMeeting({
      id: 'rec-demo1',
      title: '季度履约复盘会',
      source: 'tencent',
      startedAt: '2026-11-25T09:00:00+08:00',
      durationMs: 1800_000,
      status: 'review',
      recorderId: 'ou_1',
      participantIds: ['ou_1'],
      knowledge: { off: false },
      minutes: {
        title: '季度履约复盘会',
        overview: '明确了本月底前完成两项关键交付。',
        chapters: [],
        conclusions: [{ text: '月底前回收尾款', evidence: ['seg-0001'] }],
        decisions: [{ text: '周五前完成压测', evidence: ['seg-0002'] }],
        openQuestions: [],
        generation: { provider: 'deepseek', model: 'deepseek-flash', promptVersion: 'v1', generatedAt: '2026-11-25T09:30:00Z' },
      },
      transcript: {
        meetingId: 'rec-demo1',
        language: 'zh',
        scene: 'online',
        speakers: [{ id: 'S1', label: '我', track: 'mic', personId: 'ou_1', source: 'self' }],
        segments,
      },
      todos: [
        { id: 't1', title: '核对合同回款', ownerMention: '张三', ownerSpeakerId: 'S1', ownerPersonId: 'ou_1', ownerBasis: 'assigned', ownerConfidence: 0.9, external: false, due: '2026-11-28', dueText: '周五前', evidence: ['seg-0001'], status: 'draft' },
        { id: 't2', title: '跟进客户验收签字', ownerMention: '王总', ownerSpeakerId: 'S1', ownerPersonId: null, ownerBasis: 'assigned', ownerConfidence: 0.8, external: true, due: '2026-11-30', dueText: '月底前', evidence: ['seg-0002'], status: 'draft' },
      ],
    });

    // 3. Status, list, get, search tools all return lossless JSON
    const statusOut = await host.registeredTools.get('echomind_status').execute({}, {});
    assertLossless(statusOut);
    assert.equal(statusOut.meetingsCount, 1);

    const listOut = await host.registeredTools.get('echomind_list_meetings').execute({}, {});
    assertLossless(listOut);
    assert.equal(listOut.rows.length, 1);
    assert.ok(listOut.columns.includes('会议标题'));

    const getOut = await host.registeredTools.get('echomind_get_meeting').execute({ meetingId: 'rec-demo1' }, {});
    assertLossless(getOut);
    assert.equal(getOut.kind, MINUTES_CARD_KIND);
    assert.equal('segments' in getOut, false); // Full transcript never dumped into get_meeting

    // Search respects maxChars truncation ceiling (<= 12,000 chars)
    const searchOut = await host.registeredTools.get('echomind_search_transcript').execute({ keyword: '回款', limit: 30 }, {});
    assertLossless(searchOut);
    assert.equal(searchOut.truncated, true);
    assert.ok(JSON.stringify(searchOut).length < 20_000);

    // 4. Without signed-in account, echomind_stage_todo_push returns 约定 C
    const authNeeded = await host.registeredTools.get('echomind_stage_todo_push').execute({ meetingId: 'rec-demo1' }, {});
    assertLossless(authNeeded);
    assert.equal(authNeeded.kind, AUTH_REQUIRED_KIND);

    // 5. Simulate signed-in account via credential + config, then stage draft & confirm via RPC only
    const accountId = 'em_00112233445566778899aabb';
    writeFileSync(
      inst.paths.configPath,
      JSON.stringify({
        version: 1,
        serverUrl: 'https://58.87.77.127:8443',
        activeAccountId: accountId,
        accounts: [{ id: accountId, openId: 'ou_1', name: '张三', joinCode: 'SZ01', status: 'ok' }],
      }),
    );
    writeFileSync(
      inst.paths.credentialsPath,
      JSON.stringify({
        version: 1,
        records: { 'echomind/acct-00112233445566778899aabb': { kind: 'grant', payload: { version: 1, token: 'tok-valid', serverUrl: 'https://58.87.77.127:8443', openId: 'ou_1', joinCode: 'SZ01' } } },
      }),
    );

    const staged = await host.registeredTools.get('echomind_stage_todo_push').execute({ meetingId: 'rec-demo1' }, {});
    assertLossless(staged);
    assert.equal(staged.kind, TODO_DRAFT_KIND);
    assert.equal(createdTasks.length, 0); // Staging NEVER creates Feishu tasks

    // First confirm fails on 2nd item -> partial result, 1st item saved with feishuTaskId
    const partial = await inst.remoteHandlers.confirmPushTodos(staged.draftId, staged.todos);
    assert.equal(partial.status, 'partial');
    assert.equal(partial.pushed.length, 1);
    assert.equal(createdTasks.length, 1);

    // Retry skips already-pushed 1st item and only creates 2nd item (external reminder for recorder)
    failOnSecond = false;
    const completed = await inst.remoteHandlers.confirmPushTodos(staged.draftId, staged.todos);
    assert.equal(completed.status, 'pushed');
    assert.equal(createdTasks.length, 2);
    assert.ok(createdTasks[1].task.title.startsWith('跟进：'));
    assert.equal(createdTasks[1].task.assigneeId, 'ou_1');

    // listVoiceprints enriches openIds with real names, departments & titles from Feishu directory
    const vpOut = await inst.remoteHandlers.listVoiceprints();
    assert.equal(vpOut.voiceprints.length, 2);
    assert.equal(vpOut.voiceprints[0].name, '张三');
    assert.equal(vpOut.voiceprints[0].department, '研发部');
    assert.equal(vpOut.voiceprints[0].isSelf, true);
    assert.equal(vpOut.voiceprints[1].name, '李四');
    assert.equal(vpOut.colleagues.length, 2);

    // dismissJob clears a waiting/failed job cleanly
    const dismissed = await inst.remoteHandlers.dismissJob('rec-demo1');
    assert.equal(dismissed.ok, true);
  } finally {
    inst.dispose();
  }
});
