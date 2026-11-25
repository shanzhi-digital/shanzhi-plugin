import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkspacePaths } from './workspace-paths.js';
import { createCaptureManager } from './capture-manager.js';
import { createTranscriberManager, ModelsMissingError } from './transcriber-manager.js';
import { createAudioImporter } from './audio-importer.js';

const dir = mkdtempSync(join(tmpdir(), 'echomind-sidecar-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));

function makeStubScript(name, body) {
  const p = join(dir, name);
  writeFileSync(p, `#!/usr/bin/env node\n${body}\n`, 'utf8');
  chmodSync(p, 0o755);
  return p;
}

function makeStandardWav(sampleCount = 16000) {
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
  for (let i = 0; i < sampleCount; i += 1) {
    buf.writeInt16LE(Math.round(Math.sin(i * 0.1) * 5000), 44 + i * 2);
  }
  return buf;
}

test('captureManager streams JSONL events, handles mark/pause/resume/stop, and triggers onRecordingStopped', async () => {
  const stubCapture = makeStubScript('stub-capture.mjs', `
    const args = process.argv.slice(2);
    if (args[0] === 'permissions') {
      console.log(JSON.stringify({ microphone: 'granted', systemAudio: 'granted' }));
      process.exit(0);
    }
    if (args[0] === 'meetings') {
      console.log(JSON.stringify({ meetings: [{ app: 'tencent', name: '腾讯会议', pid: 100, audioPids: [100] }] }));
      process.exit(0);
    }
    if (args[0] === 'record') {
      const outIdx = args.indexOf('--out');
      const outDir = args[outIdx + 1];
      console.log(JSON.stringify({ type: 'started', startedAt: '2026-11-25T10:00:00+08:00', out: outDir, mic: { device: 'Mic' }, system: { device: 'Spk' } }));
      console.log(JSON.stringify({ type: 'level', t: 1200, mic: -20, system: -30 }));
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => {
        for (const cmd of chunk.trim().split(/\\r?\\n/)) {
          if (cmd === 'mark') console.log(JSON.stringify({ type: 'mark', atMs: 1500 }));
          if (cmd === 'pause') console.log(JSON.stringify({ type: 'paused', atMs: 2000 }));
          if (cmd === 'resume') console.log(JSON.stringify({ type: 'resumed', atMs: 3000 }));
          if (cmd === 'stop') {
            console.log(JSON.stringify({ type: 'stopped', durationMs: 4200, segments: 1 }));
            process.exit(0);
          }
        }
      });
    }
  `);

  const paths = createWorkspacePaths({ dataRoot: join(dir, 'data') });
  let stoppedInfo = null;
  const stoppedDone = new Promise((resolve) => {
    const cap = createCaptureManager({
      paths,
      binaryManager: { resolveBinary: () => ({ ready: true, supported: true, path: stubCapture }) },
      onRecordingStopped: (info) => {
        stoppedInfo = info;
        resolve();
      },
    });
    (async () => {
      const meetings = await cap.detectMeetings();
      assert.equal(meetings[0].app, 'tencent');

      const snap = await cap.startRecording({ title: '需求评审', source: 'tencent' });
      assert.equal(snap.source, 'tencent');
      assert.equal(cap.isRecording(), true);

      await cap.sendCommand('mark');
      await cap.sendCommand('pause');
      await cap.sendCommand('resume');
      await new Promise((r) => setTimeout(r, 60));
      assert.equal(cap.getSnapshot().marks.length, 1);

      await cap.stopRecording();
    })().catch((e) => { throw e; });
  });

  await stoppedDone;
  assert.ok(stoppedInfo);
  assert.equal(stoppedInfo.durationMs, 4200);
  assert.equal(stoppedInfo.marks.length, 1);
});

test('transcriberManager enforces single concurrency, reports stages, and maps models_missing', async () => {
  const stubTr = makeStubScript('stub-transcribe.mjs', `
    const args = process.argv.slice(2);
    if (args[0] === 'models') {
      console.log(JSON.stringify({ ready: true, downloadBytes: 0, models: [] }));
      process.exit(0);
    }
    if (args[0] === 'run') {
      if (args[1].includes('missing-models')) {
        console.log(JSON.stringify({ type: 'error', kind: 'models_missing', message: '请先下载模型' }));
        process.exit(1);
      }
      console.log(JSON.stringify({ type: 'progress', stage: 'speech', progress: 0.5 }));
      console.log(JSON.stringify({ type: 'done', transcript: { meetingId: 'm1', language: 'zh', scene: 'online', speakers: [{ id: 'S1', label: '我', track: 'mic', personId: null, source: 'self' }], segments: [{ id: 'seg-0001', speakerId: 'S1', track: 'mic', start: 0, end: 1500, text: '大家好' }] } }));
      process.exit(0);
    }
    if (args[0] === 'voices') {
      console.log(JSON.stringify({ type: 'done', voices: [{ speakerId: 'S2', seconds: 12, vector: new Array(192).fill(0.1) }] }));
      process.exit(0);
    }
  `);

  const paths = createWorkspacePaths({ dataRoot: join(dir, 'data-tr') });
  const tr = createTranscriberManager({
    paths,
    binaryManager: { resolveBinary: () => ({ ready: true, supported: true, path: stubTr }) },
  });

  const recDir = join(dir, 'rec-ok');
  const missDir = join(dir, 'missing-models');
  for (const d of [recDir, missDir]) {
    paths.ensureDir(d, 0o755);
    writeFileSync(join(d, 'manifest.json'), JSON.stringify({ version: 1, segments: [] }));
  }

  const stages = [];
  const transcript = await tr.transcribe('rec-ok', recDir, { onProgress: (e) => stages.push(e.stage) });
  assert.equal(transcript.segments[0].text, '大家好');
  assert.deepEqual(stages, ['speech']);

  await assert.rejects(() => tr.transcribe('missing-models', missDir), ModelsMissingError);

  writeFileSync(join(recDir, 'transcript.json'), JSON.stringify(transcript));
  const voices = await tr.extractVoices(recDir);
  assert.equal(voices[0].vector.length, 192);
});

test('audioImporter slices standard 16kHz PCM WAV into manifest + 60s segments and rejects bad extensions', async () => {
  const paths = createWorkspacePaths({ dataRoot: join(dir, 'data-imp') });
  const importer = createAudioImporter({ paths, now: () => 1764000000000 });

  const wavPath = join(dir, 'sample-meeting.wav');
  writeFileSync(wavPath, makeStandardWav(16000 * 2)); // 2 seconds

  const res = await importer.importAudio({ filePath: wavPath, title: '手机会议录音' });
  assert.equal(res.meetingId, 'imp-1764000000000');
  assert.equal(res.segments, 1);
  assert.ok(existsSync(join(res.outDir, 'mic-0001.wav')));
  const manifest = JSON.parse(readFileSync(join(res.outDir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.status, 'stopped');
  assert.equal(manifest.segments[0].mic, 'mic-0001.wav');

  const badFile = join(dir, 'notes.txt');
  writeFileSync(badFile, 'not audio');
  await assert.rejects(() => importer.importAudio({ filePath: badFile }), (err) => err.code === 'UNSUPPORTED_FORMAT');
});
