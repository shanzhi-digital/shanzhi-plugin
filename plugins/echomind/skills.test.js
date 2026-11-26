import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import {
  BUNDLED_SKILL_NAMES,
  SKILLS_DIR,
  createSkillProvider,
  parseSkillFile,
  setupEchoMind,
} from './index.js';

// 白名单：允许在跨插件协同 skill 中点名的宿主/兄弟插件工具。
const EXTERNAL_TOOLS = new Set(['query_result_chart', 'contract_query']);
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const DESCRIPTION_MAX = 500;

const workDir = mkdtempSync(join(tmpdir(), 'echomind-skills-'));
test.after(() => rmSync(workDir, { recursive: true, force: true }));

function registeredToolNames() {
  const tools = [];
  const ctx = {
    tools: { register(def) { tools.push(def.name); } },
    get(name) { return this[name]; },
    effect() {},
  };
  const inst = setupEchoMind(ctx, { dataRoot: workDir, enableBackgroundTimers: false });
  inst.dispose();
  return new Set(tools);
}

function listFiles(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? listFiles(full) : [full];
  });
}

function frontmatterOf(raw) {
  const block = /^---\n([\s\S]*?)\n---\n/u.exec(raw);
  assert.ok(block, '缺少 frontmatter');
  return Object.fromEntries(
    block[1].split('\n').map((line) => {
      const pair = /^([A-Za-z][\w-]*): (.+)$/u.exec(line);
      assert.ok(pair, `frontmatter 每行都应是单行 key: value，实际：${line}`);
      return [pair[1], pair[2]];
    }),
  );
}

test('skills 目录正好包含登记的 5 个 skill', () => {
  const dirs = readdirSync(SKILLS_DIR).filter((entry) => statSync(join(SKILLS_DIR, entry)).isDirectory());
  assert.deepEqual(dirs.sort(), [...BUNDLED_SKILL_NAMES].sort());
  assert.equal(BUNDLED_SKILL_NAMES.length, 5);
});

test('每个 SKILL.md frontmatter 合法且无 YAML 标量陷阱', () => {
  for (const skillName of BUNDLED_SKILL_NAMES) {
    const raw = readFileSync(join(SKILLS_DIR, skillName, 'SKILL.md'), 'utf8');
    const meta = frontmatterOf(raw);
    assert.deepEqual(Object.keys(meta).sort(), ['description', 'name']);
    assert.match(meta.name, SKILL_NAME);
    assert.equal(meta.name, skillName);
    assert.ok(meta.name.startsWith('echomind-'));
    assert.ok(meta.description.length > 0 && meta.description.length <= DESCRIPTION_MAX);
    assert.doesNotMatch(meta.description, /: | #|^[-?:,[\]{}#&*!|>'"%@`]/u);
    const parsed = parseSkillFile(raw, skillName);
    assert.equal(parsed.description, meta.description);
  }
});

test('Skill 正文引用的全部蛇形工具名均属于已注册 8 个工具或白名单外部工具', () => {
  const tools = registeredToolNames();
  assert.equal(tools.size, 8);
  const seen = new Set();
  for (const skillName of BUNDLED_SKILL_NAMES) {
    for (const file of listFiles(join(SKILLS_DIR, skillName)).filter((f) => f.endsWith('.md'))) {
      const text = readFileSync(file, 'utf8');
      for (const [, span] of text.matchAll(/`([^`\n]+)`/gu)) {
        const tool = /^([a-z][a-z0-9]*(?:_[a-z0-9]+)+)(?:\(.*\))?$/u.exec(span)?.[1];
        if (!tool) continue;
        seen.add(tool);
        assert.ok(tools.has(tool) || EXTERNAL_TOOLS.has(tool), `${relative(SKILLS_DIR, file)} 引用了未知工具 ${tool}`);
      }
    }
  }
  for (const expected of [
    'echomind_status',
    'echomind_recording_control',
    'echomind_import_audio',
    'echomind_list_meetings',
    'echomind_get_meeting',
    'echomind_search_transcript',
    'echomind_process_meeting',
    'echomind_stage_todo_push',
  ]) {
    assert.ok(seen.has(expected), `至少应有一个 skill 覆盖工具 ${expected}`);
  }
});

test('createSkillProvider 正常列出并加载全部 5 个内置 skill', async () => {
  const provider = createSkillProvider();
  const { candidates, complete } = await provider.list();
  assert.equal(complete, true);
  assert.equal(candidates.length, 5);
  for (const c of candidates) {
    const full = await provider.get(c);
    assert.ok(full && full.content.length > 40);
  }
});
