import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCredentialStore, credentialKey } from './credential-store.js';

const dir = mkdtempSync(join(tmpdir(), 'echomind-cred-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));

test('credentialKey enforces strict lowercase segment format', () => {
  assert.equal(credentialKey('acct-abc123'), 'echomind/acct-abc123');
  assert.throws(() => credentialKey('Acct_123'), TypeError);
  assert.throws(() => credentialKey('1abc'), TypeError);
});

test('uses host ctx.get("credentials") when available and never touches fallback file', async () => {
  const mem = new Map();
  const ctx = {
    get(name) {
      if (name !== 'credentials') return undefined;
      return {
        async readRecord(k) { return mem.get(k); },
        async modifyRecord(k, fn) { mem.set(k, await fn(mem.get(k))); },
        async deleteRecord(k) { mem.delete(k); },
      };
    },
  };
  const filePath = join(dir, 'unused-creds.json');
  const store = createCredentialStore(ctx, { filePath });
  assert.equal(store.kind(), 'dsh-credentials');

  await store.write('acct-a1', { kind: 'grant', payload: { token: 'secret-1' } });
  const got = await store.read('acct-a1');
  assert.equal(got.payload.token, 'secret-1');
  assert.equal(mem.has('echomind/acct-a1'), true);

  await store.remove('acct-a1');
  assert.equal(await store.read('acct-a1'), undefined);
});

test('file fallback persists 0600 records and refuses overwriting corrupted JSON', async () => {
  const filePath = join(dir, 'creds.json');
  const store = createCredentialStore(null, { filePath });
  assert.equal(store.kind(), 'file');

  await store.write('acct-b2', { kind: 'grant', payload: { token: 'tok-2' } });
  assert.equal((await store.read('acct-b2')).payload.token, 'tok-2');

  writeFileSync(filePath, '{corrupted json', 'utf8');
  await assert.rejects(() => store.read('acct-b2'), (err) => err.code === 'CREDENTIAL_READ_FAILED');
  await assert.rejects(() => store.write('acct-b3', { kind: 'grant' }), (err) => err.code === 'CREDENTIAL_READ_FAILED');
});
