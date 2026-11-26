import { randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { ApiError } from './api-client.js';
import { validMeetingId } from './workspace-paths.js';

// 双轨混音流式回放服务（完整移植自 apps/desktop/src-tauri/src/playback.rs）：
// - 懒启动监听 127.0.0.1:0（OS 分配随机端口），路径带 256-bit 随机口令 /audio/<token>/<meetingId>.wav；
// - 按字节 Range 即时读取对应时间轴上的 mic 与 system 分段 WAV 样本相加钳位（i16），暂停段补静音；
// - 零磁盘中间文件，2 小时会议任意位置秒级 Seek；
// - 同步提供 getAudioSlice(meetingId, startMs, durationMs) 用于极端 CSP 受限环境的 Blob 回退播放。

const HEADER_BYTES = 44;
const CHUNK_BYTES = 1 << 20; // ~32s @ 16kHz mono 16-bit
const TRACKS = ['mic', 'system'];

function safeSegmentName(name) {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    !name.includes('/') &&
    !name.includes('\\') &&
    name !== '..' &&
    name !== '.'
  );
}

function layoutTracks(dir) {
  const tracks = [[], []];
  let manifest = null;
  try {
    manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  } catch {
    manifest = null;
  }

  if (!manifest || !Array.isArray(manifest.segments)) {
    for (let index = 1; index < 10_000; index += 1) {
      const files = TRACKS.map((t) => join(dir, `${t}-${String(index).padStart(4, '0')}.wav`));
      if (!files.some((f) => existsSync(f))) break;
      for (let i = 0; i < 2; i += 1) {
        tracks[i].push([(index - 1) * 60_000, files[i]]);
      }
    }
    return tracks;
  }

  for (const seg of manifest.segments) {
    const startMs = Number(seg?.startMs) || 0;
    const names = [seg?.mic, seg?.system];
    for (let i = 0; i < 2; i += 1) {
      if (safeSegmentName(names[i])) {
        tracks[i].push([startMs, join(dir, names[i])]);
      }
    }
  }

  if (manifest.status !== 'stopped') {
    const last = manifest.segments[manifest.segments.length - 1];
    const nextIdx = last ? (Number(last.index) || 0) + 1 : 1;
    let startMs = last ? Number(last.endMs) || 0 : 0;
    const paused = Array.isArray(manifest.paused) ? manifest.paused : [];
    const lastPause = paused[paused.length - 1];
    if (lastPause && Number(lastPause.fromMs) >= startMs) {
      startMs = lastPause.toMs != null ? Number(lastPause.toMs) : Number(lastPause.fromMs);
    }
    for (let i = 0; i < 2; i += 1) {
      tracks[i].push([startMs, join(dir, `${TRACKS[i]}-${String(nextIdx).padStart(4, '0')}.wav`)]);
    }
  }
  return tracks;
}

function wavSamples(filePath) {
  let fd;
  try {
    fd = openSync(filePath, 'r');
    const fileLen = statSync(filePath).size;
    if (fileLen < 44) return null;
    const riff = Buffer.alloc(12);
    if (readSync(fd, riff, 0, 12, 0) < 12) return null;
    if (riff.toString('ascii', 0, 4) !== 'RIFF' || riff.toString('ascii', 8, 12) !== 'WAVE') return null;

    let rate = null;
    let pos = 12;
    while (pos + 8 <= fileLen) {
      const head = Buffer.alloc(8);
      if (readSync(fd, head, 0, 8, pos) < 8) break;
      const id = head.toString('ascii', 0, 4);
      const size = head.readUInt32LE(4);
      pos += 8;
      if (id === 'fmt ' && size >= 16) {
        const body = Buffer.alloc(16);
        if (readSync(fd, body, 0, 16, pos) < 16) return null;
        const format = body.readUInt16LE(0);
        const channels = body.readUInt16LE(2);
        const bits = body.readUInt16LE(14);
        if (format !== 1 || channels !== 1 || bits !== 16) return null;
        rate = body.readUInt32LE(4);
      } else if (id === 'data') {
        if (!rate || rate <= 0) return null;
        const rest = Math.max(0, fileLen - pos);
        let followed = false;
        if (size > 0 && size <= rest) {
          if (rest - size < 8) {
            followed = true;
          } else {
            const tail = Buffer.alloc(4);
            const nextPos = pos + size + (size & 1);
            if (readSync(fd, tail, 0, 4, nextPos) === 4) {
              followed = [...tail].every((b) => (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a) || b === 0x20);
            }
          }
        }
        const dataBytes = followed ? size : rest;
        return { rate, offset: pos, len: Math.floor(dataBytes / 2) };
      }
      pos += size + (size & 1);
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch {}
    }
  }
}

export class AudioMix {
  constructor(rate, samples, tracks) {
    this.rate = rate;
    this.samples = samples;
    this.tracks = tracks;
  }

  static open(dir) {
    let rate = null;
    const tracks = [];
    for (const files of layoutTracks(dir)) {
      const pieces = [];
      for (const [startMs, filePath] of files) {
        const info = wavSamples(filePath);
        if (!info || info.len === 0) continue;
        if (rate === null) rate = info.rate;
        if (info.rate !== rate) continue;
        pieces.push({
          start: Math.floor((startMs * info.rate) / 1000),
          len: info.len,
          path: filePath,
          offset: info.offset,
        });
      }
      pieces.sort((a, b) => a.start - b.start);
      for (let i = 1; i < pieces.length; i += 1) {
        const nextStart = pieces[i].start;
        const prev = pieces[i - 1];
        prev.len = Math.min(prev.len, Math.max(0, nextStart - prev.start));
      }
      tracks.push(pieces.filter((p) => p.len > 0));
    }
    let maxEnd = 0;
    for (const pieces of tracks) {
      for (const p of pieces) {
        if (p.start + p.len > maxEnd) maxEnd = p.start + p.len;
      }
    }
    if (!rate || maxEnd === 0) return null;
    return new AudioMix(rate, maxEnd, tracks);
  }

  totalBytes() {
    return HEADER_BYTES + this.samples * 2;
  }

  durationMs() {
    return Math.round((this.samples * 1000) / this.rate);
  }

  headerBuffer(sampleCount = this.samples) {
    const data = Math.min(sampleCount * 2, 0xffffffff - 36);
    const h = Buffer.alloc(44);
    h.write('RIFF', 0, 'ascii');
    h.writeUInt32LE(36 + data, 4);
    h.write('WAVEfmt ', 8, 'ascii');
    h.writeUInt32LE(16, 16);
    h.writeUInt16LE(1, 20);
    h.writeUInt16LE(1, 22);
    h.writeUInt32LE(this.rate, 24);
    h.writeUInt32LE(this.rate * 2, 28);
    h.writeUInt16LE(2, 32);
    h.writeUInt16LE(16, 34);
    h.write('data', 36, 'ascii');
    h.writeUInt32LE(data, 40);
    return h;
  }

  mixedSamples(fromSample, toSample) {
    const count = Math.max(0, toSample - fromSample);
    const sum = new Int32Array(count);
    for (const pieces of this.tracks) {
      for (const p of pieces) {
        if (p.start + p.len <= fromSample) continue;
        if (p.start >= toSample) break;
        const a = Math.max(fromSample, p.start);
        const b = Math.min(toSample, p.start + p.len);
        const needBytes = (b - a) * 2;
        if (needBytes <= 0) continue;
        let fd;
        try {
          fd = openSync(p.path, 'r');
          const raw = Buffer.alloc(needBytes);
          const got = readSync(fd, raw, 0, needBytes, p.offset + (a - p.start) * 2);
          const sampleGot = Math.floor(got / 2);
          const dstBase = a - fromSample;
          for (let i = 0; i < sampleGot; i += 1) {
            sum[dstBase + i] += raw.readInt16LE(i * 2);
          }
        } catch {
          // Missing file reads as silence.
        } finally {
          if (fd !== undefined) {
            try { closeSync(fd); } catch {}
          }
        }
      }
    }
    const out = Buffer.alloc(count * 2);
    for (let i = 0; i < count; i += 1) {
      const clamped = Math.max(-32768, Math.min(32767, sum[i]));
      out.writeInt16LE(clamped, i * 2);
    }
    return out;
  }

  /** 读取虚拟 WAV 的字节闭区间 [from, to]。 */
  readBytes(from, to) {
    const parts = [];
    if (from < HEADER_BYTES) {
      const endHeader = Math.min(to, HEADER_BYTES - 1);
      parts.push(this.headerBuffer().subarray(from, endHeader + 1));
    }
    if (to >= HEADER_BYTES) {
      const a = Math.max(from, HEADER_BYTES) - HEADER_BYTES;
      const b = to - HEADER_BYTES + 1;
      const sampleFrom = Math.floor(a / 2);
      const sampleTo = Math.ceil(b / 2);
      const pcm = this.mixedSamples(sampleFrom, sampleTo);
      const skip = a % 2;
      parts.push(pcm.subarray(skip, skip + (b - a)));
    }
    return Buffer.concat(parts);
  }

  /** 导出局部时间窗口为完整独立 WAV Buffer（供 Blob 回退播放）。 */
  sliceWav(startMs, durationMs) {
    const clampedStartMs = Math.max(0, Number(startMs) || 0);
    const clampedDurMs = Math.max(500, Math.min(120_000, Number(durationMs) || 30_000));
    const fromSample = Math.min(this.samples, Math.floor((clampedStartMs * this.rate) / 1000));
    const toSample = Math.min(this.samples, fromSample + Math.floor((clampedDurMs * this.rate) / 1000));
    const pcm = this.mixedSamples(fromSample, toSample);
    return Buffer.concat([this.headerBuffer(toSample - fromSample), pcm]);
  }
}

function parseRange(headerValue, total) {
  if (!headerValue || typeof headerValue !== 'string') return null;
  const match = /^bytes=(\d*)-(\d*)$/u.exec(headerValue.trim());
  if (!match) return 'invalid';
  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return 'invalid';
  let start;
  let end;
  if (!rawStart) {
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return 'invalid';
    start = Math.max(0, total - suffix);
    end = total - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd ? Math.min(total - 1, Number(rawEnd)) : total - 1;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start >= total || start > end) {
    return 'invalid';
  }
  return { start, end: Math.min(end, start + CHUNK_BYTES - 1) };
}

function tokenEquals(provided, expected) {
  const a = Buffer.from(String(provided || ''), 'utf8');
  const b = Buffer.from(String(expected || ''), 'utf8');
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

export function createPlaybackServer({ paths } = {}) {
  const token = randomBytes(32).toString('hex');
  let server = null;
  let port = 0;
  let starting = null;

  async function ensureStarted() {
    if (server && port > 0) return port;
    if (starting) return starting;
    starting = new Promise((resolveStart, rejectStart) => {
      const srv = createServer((req, res) => {
        const host = String(req.headers.host || '').split(':')[0];
        if (host !== '127.0.0.1' && host !== 'localhost') {
          res.writeHead(403);
          res.end();
          return;
        }
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405);
          res.end();
          return;
        }
        let pathname;
        try {
          pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname;
        } catch {
          res.writeHead(400);
          res.end();
          return;
        }
        const match = /^\/audio\/([0-9a-f]{64})\/([A-Za-z0-9._-]{1,80})\.wav$/u.exec(pathname);
        if (!match || !tokenEquals(match[1], token)) {
          res.writeHead(403);
          res.end();
          return;
        }
        const meetingId = match[2];
        if (!validMeetingId(meetingId)) {
          res.writeHead(400);
          res.end();
          return;
        }
        const dir = paths.resolveMeetingDir(meetingId, { mustExist: true });
        if (!dir) {
          res.writeHead(404);
          res.end();
          return;
        }
        const mix = AudioMix.open(dir);
        if (!mix) {
          res.writeHead(404);
          res.end();
          return;
        }
        const total = mix.totalBytes();
        const rangeHeader = req.headers.range;
        if (rangeHeader) {
          const range = parseRange(rangeHeader, total);
          if (range === 'invalid') {
            res.writeHead(416, { 'Content-Range': `bytes */${total}` });
            res.end();
            return;
          }
          const body = req.method === 'HEAD' ? Buffer.alloc(0) : mix.readBytes(range.start, range.end);
          res.writeHead(206, {
            'Content-Type': 'audio/wav',
            'Accept-Ranges': 'bytes',
            'Content-Range': `bytes ${range.start}-${range.end}/${total}`,
            'Content-Length': String(range.end - range.start + 1),
            'Cache-Control': 'no-store',
          });
          res.end(body);
          return;
        }
        const end = Math.min(total - 1, CHUNK_BYTES - 1);
        const body = req.method === 'HEAD' ? Buffer.alloc(0) : mix.readBytes(0, end);
        res.writeHead(total > CHUNK_BYTES ? 206 : 200, {
          'Content-Type': 'audio/wav',
          'Accept-Ranges': 'bytes',
          ...(total > CHUNK_BYTES ? { 'Content-Range': `bytes 0-${end}/${total}` } : {}),
          'Content-Length': String(end + 1),
          'Cache-Control': 'no-store',
        });
        res.end(body);
      });

      srv.once('error', (err) => {
        starting = null;
        rejectStart(err);
      });
      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address();
        port = typeof addr === 'object' && addr ? addr.port : 0;
        server = srv;
        starting = null;
        resolveStart(port);
      });
    });
    return starting;
  }

  async function getPlaybackInfo(meetingId) {
    if (!validMeetingId(meetingId)) {
      throw new ApiError('会议编号不合法。', { code: 'INVALID_REQUEST' });
    }
    const dir = paths.resolveMeetingDir(meetingId, { mustExist: true });
    if (!dir) {
      throw new ApiError('找不到该会议的本地录音目录。', { code: 'NOT_FOUND' });
    }
    const mix = AudioMix.open(dir);
    if (!mix) {
      throw new ApiError('该会议没有可播放的本地 WAV 录音。', { code: 'NOT_FOUND' });
    }
    const listenPort = await ensureStarted();
    return {
      meetingId,
      url: `http://127.0.0.1:${listenPort}/audio/${token}/${meetingId}.wav`,
      durationMs: mix.durationMs(),
      sampleRate: mix.rate,
    };
  }

  function getAudioSlice(meetingId, startMs = 0, durationMs = 30_000) {
    if (!validMeetingId(meetingId)) {
      throw new ApiError('会议编号不合法。', { code: 'INVALID_REQUEST' });
    }
    const dir = paths.resolveMeetingDir(meetingId, { mustExist: true });
    if (!dir) throw new ApiError('找不到该会议的本地录音目录。', { code: 'NOT_FOUND' });
    const mix = AudioMix.open(dir);
    if (!mix) throw new ApiError('该会议没有可播放的本地 WAV 录音。', { code: 'NOT_FOUND' });
    const wav = mix.sliceWav(startMs, durationMs);
    return {
      meetingId,
      mimeType: 'audio/wav',
      startMs: Math.max(0, Number(startMs) || 0),
      durationMs: Math.round(((wav.byteLength - HEADER_BYTES) / (mix.rate * 2)) * 1000),
      totalDurationMs: mix.durationMs(),
      base64: wav.toString('base64'),
    };
  }

  function dispose() {
    if (server) {
      try { server.close(); } catch {}
      server = null;
      port = 0;
    }
  }

  return {
    getPlaybackInfo,
    getAudioSlice,
    dispose,
  };
}
