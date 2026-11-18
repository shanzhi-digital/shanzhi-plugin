import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

test('包入口、分发资源与宿主 peerDependencies 完整', () => {
  assert.equal(manifest.type, 'module');
  assert.equal(manifest.exports['.'], './index.js');
  assert.equal(manifest.exports['./client'], './client.js');
  assert.ok(manifest.files.includes('assets/skills/*/SKILL.md'));
  assert.ok(manifest.files.includes('client.js'));
  assert.ok(manifest.files.includes('transport.js'));
  for (const name of ['dsh-credentials', 'dsh-mcp-client', 'dsh-mcp-manager', 'dsh-skill', 'dsh-typert-protocol', 'dsh-settings']) {
    assert.equal(manifest.peerDependencies[`@deepseek-ai/${name}`], '0.2.2-rc.1');
  }
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-settings'));
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-settings-general'));
});
