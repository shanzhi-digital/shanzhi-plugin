import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkspacePaths } from './workspace-paths.js';
import { createBinaryManager } from './binary-manager.js';

const dir = mkdtempSync(join(tmpdir(), 'echomind-bin-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));

test('downloads binaries from mirror with strict SHA-256 verification and rejects tampered payloads', async () => {
  const capBytes = Buffer.from('#!/bin/sh\necho capture\n');
  const trBytes = Buffer.from('#!/bin/sh\necho transcribe\n');
  const capHash = createHash('sha256').update(capBytes).digest('hex');
  const trHash = createHash('sha256').update(trBytes).digest('hex');

  const manifestPath = join(dir, 'manifest.json');
  writeFileSync(
    manifestPath,
    JSON.stringify({
      version: '0.1.0',
      platforms: {
        'darwin-arm64': {
          capture: { filename: 'echomind-capture', artifact: 'cap-arm64', bytes: capBytes.length, sha256: capHash },
          transcribe: { filename: 'echomind-transcribe', artifact: 'tr-arm64', bytes: trBytes.length, sha256: trHash },
        },
      },
    }),
  );

  let tamper = false;
  const server = createServer((req, res) => {
    if (req.url === '/cap-arm64') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end(tamper ? Buffer.from('tampered!') : capBytes);
      return;
    }
    if (req.url === '/tr-arm64') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end(trBytes);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const mirrorUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const paths = createWorkspacePaths({ dataRoot: join(dir, 'dsh-data') });
    const mgr = createBinaryManager({
      paths,
      manifestPath,
      platform: 'darwin',
      arch: 'arm64',
      envBinDir: () => '',
      extraSearchDirs: [],
      getMirrorUrl: () => mirrorUrl,
    });

    // Tampered file must be rejected by SHA-256 check
    tamper = true;
    await assert.rejects(() => mgr.installMissing(), (err) => err.code === 'CHECKSUM_MISMATCH');
    assert.equal(mgr.getStatus().capture.ready, false);

    // Clean payload installs cleanly
    tamper = false;
    const status = await mgr.installMissing();
    assert.equal(status.ready, true);
    assert.equal(status.capture.source, 'dsh-bin');
    assert.equal(status.transcribe.source, 'dsh-bin');
    assert.ok(existsSync(status.capture.path));
    assert.ok(existsSync(status.transcribe.path));

    // Env override takes precedence
    const envDir = join(dir, 'env-bins');
    mkdirSync(envDir, { recursive: true });
    writeFileSync(join(envDir, 'echomind-capture'), capBytes);
    const envMgr = createBinaryManager({
      paths,
      manifestPath,
      platform: 'darwin',
      arch: 'arm64',
      envBinDir: () => envDir,
      extraSearchDirs: [],
    });
    assert.equal(envMgr.resolveBinary('capture').source, 'env');
  } finally {
    server.close();
  }
});
