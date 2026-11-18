import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createBundledSkillProvider, parseBundledSkill } from './skills.js';

const assetRoot = fileURLToPath(new URL('./assets/skills/', import.meta.url));

test('两个静态 Skill 随包加载，provider/list/get 元数据完整', async () => {
  const provider = createBundledSkillProvider({ assetRoot });
  assert.equal(provider.name, 'datahub-onboarding');
  const candidates = await provider.list();
  assert.deepEqual(candidates.map(candidate => candidate.name), ['datahub-ask-data', 'datahub-knowledge']);
  for (const candidate of candidates) {
    assert.equal(candidate.provider, 'datahub-onboarding');
    assert.equal(candidate.source, 'bundled');
    assert.equal(candidate.rank, 600);
    assert.equal(candidate.invocation.modelInvocable, true);
    assert.ok(candidate.description.length > 10);
    const skill = await provider.get(candidate);
    assert.equal(skill.name, candidate.name);
    assert.equal(Object.hasOwn(skill, 'locator'), false);
    assert.equal(Object.hasOwn(skill, 'rank'), false);
    assert.ok(skill.content.startsWith('# DataHub'));
    assert.doesNotMatch(skill.content, /^---/u);
    assert.ok(skill.content.includes(candidate.name === 'datahub-ask-data' ? 'execute_semantic_sql' : 'retrieve_knowledge'));
  }
});

test('SkillProvider 不读取调用方伪造的其他文件', async () => {
  const provider = createBundledSkillProvider({ assetRoot });
  const [candidate] = await provider.list();
  assert.equal(await provider.get({ ...candidate, locator: 'C:/private/SECRET.md' }), undefined);
});

test('Skill frontmatter 必须包含合法名称与描述', () => {
  assert.throws(() => parseBundledSkill('# no metadata'), /frontmatter/);
  assert.throws(() => parseBundledSkill('---\nname: datahub-ask-data\n---\nbody'), /incomplete/);
});
