import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkspacePaths } from './workspace-paths.js';
import { createPlaybackServer } from './playback-server.js';

const dir = mkdtempSync(join(tmpdir(), 'echomind-play-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));

function makeConstWav(value, sampleCount = 1600) {
  const dataBytes = sampleCount * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVEfmt ', 8, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(16000, 24);
  buf.writeUInt32LE(32000, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < sampleCount; i += 1) buf.writeInt16LE(value, 44 + i * 2);
  return buf;
}

test('playbackServer mixes dual tracks on timeline with pause gap, enforces token & Range, and clamps i16', async () => {
  const paths = createWorkspacePaths({ dataRoot: join(dir, 'data') });
  const recDir = join(paths.resolveRecordingsDir({ ensure: true }), 'rec-play1');
  mkdirSync(recDir, { recursive: true });

  // Segment 1 (0..100ms): mic = 20000, system = 20000 -> clamped to 32767
  // Pause 100..200ms -> silence (0)
  // Segment 2 (200..300ms): mic = 1000, system = -400 -> 600
  writeFileSync(join(recDir, 'mic-0001.wav'), makeConstWav(20000, 1600));
  writeFileSync(join(recDir, 'system-0001.wav'), makeConstWav(20000, 1600));
  writeFileSync(join(recDir, 'mic-0002.wav'), makeConstWav(1000, 1600));
  writeFileSync(join(recDir, 'system-0002.wav'), makeConstWav(-400, 1600));
  writeFileSync(
    join(recDir, 'manifest.json'),
    JSON.stringify({
      version: 1,
      sampleRate: 16000,
      status: 'stopped',
      segments: [
        { index: 1, startMs: 0, endMs: 100, mic: 'mic-0001.wav', system: 'system-0001.wav' },
        { index: 2, startMs: 200, endMs: 300, mic: 'mic-0002.wav', system: 'system-0002.wav' },
      ],
      paused: [{ fromMs: 100, toMs: 200 }],
    }),
  );

  const srv = createPlaybackServer({ paths });
  try {
    const info = await srv.getPlaybackInfo('rec-play1');
    assert.equal(info.durationMs, 300);
    assert.equal(info.sampleRate, 16000);

    // Wrong token is rejected with 403
    const badTokenUrl = info.url.replace(/\/audio\/[0-9a-f]{64}\//, `/audio/${'0'.repeat(64)}/`);
    assert.equal((await fetch(badTokenUrl)).status, 403);

    // Range request returns 206 with valid RIFF header + mixed samples
    const rangeRes = await fetch(info.url, { headers: { Range: 'bytes=0-9643' } });
    assert.equal(rangeRes.status, 206);
    const bytes = Buffer.from(await rangeRes.arrayBuffer());
    assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
    // Sample 0 (seg 1): 20000 + 20000 -> clamped 32767
    assert.equal(bytes.readInt16LE(44), 32767);
    // Sample 2000 (inside 100..200ms pause gap): 0
    assert.equal(bytes.readInt16LE(44 + 2000 * 2), 0);
    // Sample 3400 (inside seg 2, 200..300ms): 1000 + (-400) = 600
    assert.equal(bytes.readInt16LE(44 + 3400 * 2), 600);

    // Fallback getAudioSlice returns valid base64 WAV
    const slice = srv.getAudioSlice('rec-play1', 200, 100);
    const wavBuf = Buffer.from(slice.base64, 'base64');
    assert.equal(wavBuf.toString('ascii', 0, 4), 'RIFF');
    assert.equal(wavBuf.readInt16LE(44), 600);
  } finally {
    srv.dispose();
  }
});
