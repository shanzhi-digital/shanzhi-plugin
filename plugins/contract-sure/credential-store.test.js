import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCredentialStore } from './credential-store.js';

const workDir = mkdtempSync(join(tmpdir(), 'contract-sure-credentials-'));
test.after(() => rmSync(workDir, { recursive: true, force: true }));
let counter = 0;
const freshFile = () => {
  const dir = join(workDir, `case-${++counter}`);
  mkdirSync(dir, { recursive: true });
  return join(dir, 'credentials.json');
};
const record = (token) => ({ kind: 'grant', payload: { version: 1, token } });

test('file mode: only a missing file is an empty store', async () => {
  const filePath = freshFile();
  const store = createCredentialStore({ get: () => undefined }, { filePath });
  assert.equal(store.kind(), 'file');
  assert.equal(await store.read('account-1'), undefined);
  await store.remove('account-1');
  assert.equal(existsSync(filePath), false);
  await store.write('account-1', record('t1'));
  await store.write('account-2', record('t2'));
  assert.deepEqual(await store.read('account-1'), record('t1'));
  await store.remove('account-1');
  assert.equal(await store.read('account-1'), undefined);
  assert.deepEqual(await store.read('account-2'), record('t2'));
});

test('file mode: a corrupt or malformed file fails reads and stops writes instead of being overwritten', async () => {
  for (const content of ['{ not json', '[]', '{"records": []}', '{"records": "x"}', 'null']) {
    const filePath = freshFile();
    writeFileSync(filePath, content, { mode: 0o600 });
    const store = createCredentialStore({ get: () => undefined }, { filePath });
    await assert.rejects(() => store.read('account-1'), (error) => error.code === 'CREDENTIAL_READ_FAILED', content);
    await assert.rejects(() => store.write('account-1', record('t1')), (error) => error.code === 'CREDENTIAL_READ_FAILED', content);
    await assert.rejects(() => store.remove('account-1'), (error) => error.code === 'CREDENTIAL_READ_FAILED', content);
    // 文件原样保留，其他记录不会被一个空库覆盖掉。
    assert.equal(readFileSync(filePath, 'utf8'), content);
  }
  // 读不了（这里用目录模拟 I/O 错误）也不是空库。
  const dirPath = freshFile();
  mkdirSync(dirPath);
  const store = createCredentialStore({ get: () => undefined }, { filePath: dirPath });
  await assert.rejects(() => store.read('account-1'), (error) => error.code === 'CREDENTIAL_READ_FAILED');
});

test('host mode: read errors are reported (not "no record"), host error text is not echoed, and the local file is not used', async () => {
  const filePath = freshFile();
  // 本地文件里有一条旧记录：宿主模式下不再拿它兜底。
  writeFileSync(filePath, JSON.stringify({ version: 1, records: { 'contract-sure/account-1': record('file-token') } }));
  let fail = false;
  const records = new Map();
  const host = {
    async readRecord(key) {
      if (fail) throw new Error(`EIO reading ${key} secret-host-detail`);
      return records.get(key);
    },
    async modifyRecord(key, mutate) {
      if (fail) throw new Error('EACCES secret-host-detail');
      records.set(key, await mutate(records.get(key)));
    },
    async deleteRecord(key) {
      if (fail) throw new Error('EACCES secret-host-detail');
      records.delete(key);
    },
  };
  const store = createCredentialStore({ get: (name) => (name === 'credentials' ? host : undefined) }, { filePath });
  assert.equal(store.kind(), 'dsh-credentials');
  assert.equal(await store.read('account-1'), undefined);
  await store.write('account-2', record('host-token'));
  assert.deepEqual(await store.read('account-2'), record('host-token'));

  fail = true;
  await assert.rejects(() => store.read('account-2'), (error) => error.code === 'CREDENTIAL_READ_FAILED' && !/secret-host-detail/u.test(error.message));
  await assert.rejects(() => store.write('account-2', record('x')), (error) => error.code === 'CREDENTIAL_WRITE_FAILED' && !/secret-host-detail/u.test(error.message));
  await assert.rejects(() => store.remove('account-2'), (error) => error.code === 'CREDENTIAL_WRITE_FAILED');
  // 宿主模式不碰本地文件。
  assert.match(readFileSync(filePath, 'utf8'), /file-token/u);
});
