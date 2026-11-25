import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import {
  BUNDLED_SKILL_NAMES,
  SKILLS_DIR,
  SKILL_PROVIDER_NAME,
  createSkillProvider,
  inject,
  parseSkillFile,
  setupSalesforge,
} from './index.js';

// skill 正文里允许点名的外部工具：宿主的 skill、read，以及 @local/datahub-echarts 提供的可选图表工具
// （正文里写明了「有这个工具时才用」）。
const HOST_TOOLS = new Set(['skill', 'read', 'query_result_chart']);
const HOST_PARAMS = new Set();
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const DESCRIPTION_MAX = 500;

const workDir = mkdtempSync(join(tmpdir(), 'salesforge-skills-'));
const configPath = join(workDir, 'dsh-config.json');

test.after(() => rmSync(workDir, { recursive: true, force: true }));

function fakeCtx(extra = {}) {
  const tools = [];
  const ctx = {
    tools: { register(def) { tools.push(def.name); } },
    get(name) { return this[name]; },
    effect() {},
    ...extra,
  };
  return { ctx, tools };
}

function registeredToolNames() {
  const { ctx, tools } = fakeCtx();
  const instance = setupSalesforge(ctx, { configPath });
  instance.dispose();
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
      assert.ok(pair, `frontmatter 每行都应是单行的 key: value，实际：${line}`);
      return [pair[1], pair[2]];
    }),
  );
}

test('skills 目录里正好是登记的 5 个 skill', () => {
  const dirs = readdirSync(SKILLS_DIR).filter((entry) => statSync(join(SKILLS_DIR, entry)).isDirectory());
  assert.deepEqual(dirs.sort(), [...BUNDLED_SKILL_NAMES].sort());
  assert.equal(BUNDLED_SKILL_NAMES.length, 5);
});

test('每个 SKILL.md 的 frontmatter 合法', () => {
  for (const skillName of BUNDLED_SKILL_NAMES) {
    const raw = readFileSync(join(SKILLS_DIR, skillName, 'SKILL.md'), 'utf8');
    const meta = frontmatterOf(raw);
    assert.deepEqual(Object.keys(meta).sort(), ['description', 'name'], `${skillName} 只能有 name 和 description`);
    assert.match(meta.name, SKILL_NAME);
    assert.equal(meta.name, skillName, 'name 要和目录名一致');
    assert.ok(meta.name.startsWith('salesforge-'), 'name 要带插件前缀');
    assert.ok(meta.description.length > 0 && meta.description.length <= DESCRIPTION_MAX, `${skillName} 的 description 有 ${meta.description.length} 字`);
    // 保证别的 YAML 解析器（例如用户把它拷进 ~/.agents/skills）也能读：不能是带特殊含义的纯量。
    assert.doesNotMatch(meta.description, /: | #|^[-?:,[\]{}#&*!|>'"%@`]/u, `${skillName} 的 description 不是合法的 YAML 纯量`);
    const parsed = parseSkillFile(raw, skillName);
    assert.equal(parsed.description, meta.description);
    assert.ok(!parsed.content.startsWith('---'));
  }
});

test('正文点名的工具都存在：本插件的工具，或宿主的看图、加载工具', () => {
  const tools = registeredToolNames();
  assert.equal(tools.size, 8);
  const seen = new Set();
  for (const skillName of BUNDLED_SKILL_NAMES) {
    for (const file of listFiles(join(SKILLS_DIR, skillName)).filter((f) => f.endsWith('.md'))) {
      const text = readFileSync(file, 'utf8');
      for (const [, span] of text.matchAll(/`([^`\n]+)`/gu)) {
        const tool = /^([a-z][a-z0-9]*(?:_[a-z0-9]+)+)(?:\(.*\))?$/u.exec(span)?.[1];
        if (!tool || HOST_PARAMS.has(tool)) continue;
        seen.add(tool);
        assert.ok(tools.has(tool) || HOST_TOOLS.has(tool), `${relative(SKILLS_DIR, file)} 引用了不存在的工具 ${tool}`);
      }
    }
  }
  // 确认检查确实抓到了引用，而不是什么都没匹配上。
  for (const tool of tools) {
    assert.ok(seen.has(tool), `skill 正文里应当用到 ${tool}`);
  }
});

test('references、templates 里的文件都在 SKILL.md 里写了文件名，写了的文件也都存在', () => {
  for (const skillName of BUNDLED_SKILL_NAMES) {
    const dir = join(SKILLS_DIR, skillName);
    const body = readFileSync(join(dir, 'SKILL.md'), 'utf8');
    const resources = listFiles(dir).map((file) => relative(dir, file).split('\\').join('/')).filter((file) => file !== 'SKILL.md');
    for (const file of resources) assert.ok(body.includes(`\`${file}\``), `${skillName}/SKILL.md 没写明 ${file}`);
    for (const [, path] of body.matchAll(/`((?:references|templates)\/[^`]+)`/gu)) {
      assert.ok(existsSync(join(dir, path)), `${skillName}/SKILL.md 提到的 ${path} 不存在`);
    }
  }
});

test('提供方 list 返回 5 个候选，字段符合宿主 skills 服务的要求', async () => {
  const provider = createSkillProvider();
  assert.equal(provider.name, SKILL_PROVIDER_NAME);
  const { candidates, complete } = await provider.list({});
  assert.equal(complete, true);
  assert.deepEqual(candidates.map((c) => c.name), [...BUNDLED_SKILL_NAMES]);
  for (const candidate of candidates) {
    assert.equal(candidate.provider, SKILL_PROVIDER_NAME);
    assert.equal(candidate.source, 'bundled');
    assert.equal(candidate.rank, 600);
    assert.deepEqual(candidate.invocation, { modelInvocable: true, userInvocable: true });
    assert.equal(candidate.path, join(SKILLS_DIR, candidate.name, 'SKILL.md'));
    assert.equal(candidate.locator, candidate.path);
    assert.equal(candidate.resourceBase.kind, 'directory');
    assert.equal(candidate.resourceBase.path, join(SKILLS_DIR, candidate.name).split('\\').join('/'));
    assert.ok(candidate.description.length <= DESCRIPTION_MAX);
  }
});

test('提供方 get 每次重新读正文，去掉 frontmatter，不带 rank 和 locator', async () => {
  const provider = createSkillProvider();
  const { candidates } = await provider.list({});
  const candidate = candidates.find((c) => c.name === 'salesforge-query-data');
  const skill = await provider.get(candidate, {});
  assert.equal(skill.name, 'salesforge-query-data');
  assert.equal(skill.provider, SKILL_PROVIDER_NAME);
  assert.equal(skill.source, 'bundled');
  assert.equal(skill.rank, undefined);
  assert.equal(skill.locator, undefined);
  assert.ok(skill.content.startsWith('# 销售数据查询'));
  assert.ok(!skill.content.includes('description:'));
});

test('提供方：坏掉或缺失的 skill 不进目录，加载时让目录失效', async () => {
  const root = join(workDir, 'skills-fixture');
  mkdirSync(join(root, 'good-skill'), { recursive: true });
  mkdirSync(join(root, 'wrong-name'), { recursive: true });
  writeFileSync(join(root, 'good-skill', 'SKILL.md'), '---\nname: good-skill\ndescription: 好的\n---\n\n# 正文\n');
  writeFileSync(join(root, 'wrong-name', 'SKILL.md'), '---\nname: other-name\ndescription: 名字不对\n---\n正文\n');
  const warnings = [];
  let invalidated = 0;
  const provider = createSkillProvider({
    skillsDir: root,
    skillNames: ['good-skill', 'wrong-name', 'missing-skill'],
    control: { invalidate: () => { invalidated += 1; } },
    logger: { warn: (message) => warnings.push(message) },
  });
  const { candidates, complete } = await provider.list({});
  assert.deepEqual(candidates.map((c) => c.name), ['good-skill']);
  assert.equal(complete, true, '缺文件和格式错误都是持久的，目录仍算完整');
  assert.equal(warnings.length, 2);
  await provider.list({});
  assert.equal(warnings.length, 2, '同样的问题只警告一次');

  const good = candidates[0];
  assert.equal((await provider.get(good, {})).content, '# 正文');
  rmSync(join(root, 'good-skill', 'SKILL.md'));
  assert.equal(await provider.get(good, {}), undefined);
  assert.equal(invalidated, 1);
});

test('skills 服务在时：注册提供方，插件卸载时注销', async () => {
  const providers = [];
  let disposed = 0;
  const skills = {
    registerProvider(create) {
      providers.push(create({ signal: new AbortController().signal, invalidate() {} }));
      return () => { disposed += 1; };
    },
  };
  const { ctx } = fakeCtx({ skills });
  const instance = setupSalesforge(ctx, { configPath });
  assert.equal(providers.length, 1);
  assert.equal(providers[0].name, SKILL_PROVIDER_NAME);
  assert.equal((await providers[0].list({})).candidates.length, 5);
  instance.dispose();
  assert.equal(disposed, 1);
});

test('skills 服务不在时插件照常启动；服务后来出现再注册', () => {
  // 硬依赖只有 tools，minimal 预设没有 skills 服务也能装。
  assert.deepEqual(inject, ['tools']);

  const bare = fakeCtx();
  const first = setupSalesforge(bare.ctx, { configPath });
  assert.equal(bare.tools.length, 8);
  first.dispose();

  const injected = [];
  const withInject = fakeCtx({ inject(deps, callback) { injected.push({ deps, callback }); } });
  const second = setupSalesforge(withInject.ctx, { configPath });
  assert.equal(withInject.tools.length, 8);
  const pending = injected.find((item) => item.deps.includes('skills'));
  assert.deepEqual(pending.deps, ['skills']);
  let registered = 0;
  pending.callback({ get: (name) => (name === 'skills' ? { registerProvider: () => { registered += 1; return () => {}; } } : undefined) });
  assert.equal(registered, 1);
  second.dispose();
});
