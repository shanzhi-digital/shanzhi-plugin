// Repair only records written by dsh-sql@0.6.0-local.1.
// Run with the installation-owned Electron in Node mode for ASAR installations.
// No credential value is printed or copied to a backup; default operation is dry-run.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, join, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  'host-root': { type: 'string' },
  'metadata-path': { type: 'string' },
  'credentials-path': { type: 'string' },
  apply: { type: 'boolean', default: false },
  'self-test': { type: 'boolean', default: false },
} });

async function run() {
  if (!values['host-root']) throw new Error('host root required');
  const providerEntry = join(resolve(values['host-root']), 'node_modules', '@deepseek-ai', 'dsh-credentials-local', 'lib', 'index.js');
  const require = createRequire(providerEntry);
  const { parseDocument, isMap, isScalar } = require('yaml');
  const { parseCredentialsDocument } = await import(pathToFileURL(providerEntry).href);
  const { withFileLock, writeFileAtomic } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-atomic-write')).href);

  function repairText(text, connections, filename) {
    const doc = parseDocument(text, { uniqueKeys: true });
    assert.equal(doc.errors.length, 0);
    const before = structuredClone(doc.toJS());
    const expected = structuredClone(before);
    const records = doc.get('records', true);
    const keys = [];
    if (records !== undefined) assert.ok(isMap(records));
    for (const connection of connections) {
      assert.match(connection.id, /^[a-z0-9-]+$/i);
      const key = `sql/dsh-datasource-${connection.id.toLowerCase()}-password`;
      const record = records?.get(key, true);
      if (!record) continue;
      assert.ok(isMap(record));
      const kind = record.get('kind', true);
      if (!isScalar(kind) || kind.value !== 'database-password') continue;
      assert.equal(typeof record.toJSON()?.payload?.password, 'string');
      kind.value = 'grant';
      expected.records[key].kind = 'grant';
      keys.push(key);
    }
    const next = keys.length ? doc.toString() : text;
    // Prove all existing values, references and unrelated records are unchanged.
    const nextDoc = parseDocument(next, { uniqueKeys: true });
    assert.equal(nextDoc.errors.length, 0);
    assert.deepEqual(nextDoc.toJS(), expected);
    parseCredentialsDocument(next, filename);
    return { next, count: keys.length };
  }

  if (values['self-test']) {
    const fixture = '# preserved fixture comment\nversion: 1\nrefs:\n  MODEL_FIXTURE_KEY: synthetic-model-key\nrecords:\n  sql/dsh-datasource-probe-password:\n    kind: database-password\n    payload:\n      password: synthetic-database-password\n  unrelated/fixture:\n    kind: grant\n    payload:\n      token: synthetic-unrelated-token\n';
    assert.throws(() => parseCredentialsDocument(fixture, 'synthetic-fixture.yaml'));
    const first = repairText(fixture, [{ id: 'probe' }], 'synthetic-fixture.yaml');
    assert.equal(first.count, 1);
    assert.match(first.next, /^# preserved fixture comment/m);
    const restored = parseCredentialsDocument(first.next, 'synthetic-fixture.yaml');
    assert.equal(restored.refs.get('MODEL_FIXTURE_KEY'), 'synthetic-model-key');
    assert.deepEqual(restored.records.get('sql/dsh-datasource-probe-password'), { kind: 'grant', payload: { password: 'synthetic-database-password' } });
    assert.deepEqual(restored.records.get('unrelated/fixture'), { kind: 'grant', payload: { token: 'synthetic-unrelated-token' } });
    const again = repairText(first.next, [{ id: 'probe' }], 'synthetic-fixture.yaml');
    assert.equal(again.count, 0);
    assert.equal(again.next, first.next);
    assert.throws(() => repairText(fixture, [{ id: 'another-connection' }], 'synthetic-fixture.yaml'));
    assert.throws(() => repairText(fixture.replace('kind: database-password', 'kind: unknown-tag'), [{ id: 'probe' }], 'synthetic-fixture.yaml'));
    console.log(JSON.stringify({ selfTest: 'passed', originalTagRejected: true, nativeGrantReloaded: true, passwordAndUnrelatedValuesPreserved: true, idempotent: true, unmatchedAndUnknownRecordsRejected: true, realCredentialsAccessed: false }));
    return;
  }

  assert.ok(values['metadata-path'] && values['credentials-path']);
  const metadataPath = resolve(values['metadata-path']);
  const credentialsPath = resolve(values['credentials-path']);
  assert.equal(basename(metadataPath), 'connections.json');
  assert.equal(basename(credentialsPath), '.credentials.yaml');
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
  assert.equal(metadata.version, 1);
  assert.ok(Array.isArray(metadata.connections));
  await withFileLock(credentialsPath, async () => {
    const original = await readFile(credentialsPath, 'utf8');
    const repaired = repairText(original, metadata.connections, credentialsPath);
    if (values.apply && repaired.count) {
      // The official credential provider uses this same lock and atomic writer.
      // Re-read before replacing, aborting if a writer ignored the shared lock.
      assert.equal(await readFile(credentialsPath, 'utf8'), original);
      await writeFileAtomic(credentialsPath, repaired.next, { mode: 0o600, dirMode: 0o700 });
      assert.equal(await readFile(credentialsPath, 'utf8'), repaired.next);
    }
    console.log(JSON.stringify({ mode: values.apply ? 'apply' : 'dry-run', matchingLegacyRecords: repaired.count, recordsMigrated: values.apply ? repaired.count : 0, nativeDocumentValidAfterRepair: true, passwordAndUnrelatedValuesPreserved: true, credentialValuesDisclosed: false }));
  }, { waitMs: 5000 });
}

try { await run(); }
catch {
  // Native/YAML/assertion errors can contain file snippets; never print them.
  console.error('Credential-format repair stopped without disclosing values. Check paths and document compatibility.');
  process.exitCode = 1;
}
