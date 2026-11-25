import { spawn } from 'node:child_process';
import {
  mkdirSync,
  openSync,
  closeSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, extname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { ApiError } from './api-client.js';

// 外部会议录音文件导入：
// - realpath 解析软链并校验真实扩展名与体积上限（500 MB），防路径穿越与符号链接绕过；
// - 若已是 16kHz 单声道 16-bit PCM WAV 直接按 60 秒切分为标准 mic-NNNN.wav + manifest.json；
// - 否则优先用 macOS 内置 afconvert 或本机 ffmpeg 转换为 16kHz 单声道 16-bit PCM WAV 后切段。

export const ALLOWED_AUDIO_EXTENSIONS = new Set(['.wav', '.m4a', '.mp3', '.flac', '.ogg', '.aac', '.mp4', '.webm']);
export const MAX_IMPORT_BYTES = 500 * 1024 * 1024;
const TARGET_RATE = 16000;
const SEGMENT_SECONDS = 60;

function writeWavHeader(dataBytes, sampleRate = TARGET_RATE) {
  const buf = Buffer.alloc(44);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVEfmt ', 8, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);
  return buf;
}

/** 解析标准 16kHz mono 16-bit PCM WAV 的 data 区间；不匹配时返回 null。 */
export function inspectStandardPcmWav(filePath) {
  const fd = openSync(filePath, 'r');
  try {
    const fileSize = statSync(filePath).size;
    if (fileSize < 44) return null;
    const riff = Buffer.alloc(12);
    if (readSync(fd, riff, 0, 12, 0) < 12) return null;
    if (riff.toString('ascii', 0, 4) !== 'RIFF' || riff.toString('ascii', 8, 12) !== 'WAVE') return null;

    let pos = 12;
    let formatOk = false;
    while (pos + 8 <= fileSize) {
      const head = Buffer.alloc(8);
      if (readSync(fd, head, 0, 8, pos) < 8) break;
      const chunkId = head.toString('ascii', 0, 4);
      const chunkSize = head.readUInt32LE(4);
      pos += 8;
      if (chunkId === 'fmt ' && chunkSize >= 16) {
        const body = Buffer.alloc(16);
        if (readSync(fd, body, 0, 16, pos) < 16) return null;
        const audioFormat = body.readUInt16LE(0);
        const channels = body.readUInt16LE(2);
        const sampleRate = body.readUInt32LE(4);
        const bitsPerSample = body.readUInt16LE(14);
        formatOk = audioFormat === 1 && channels === 1 && sampleRate === TARGET_RATE && bitsPerSample === 16;
      } else if (chunkId === 'data') {
        if (!formatOk) return null;
        const usable = Math.min(chunkSize || (fileSize - pos), fileSize - pos);
        const evenBytes = usable - (usable % 2);
        return { dataOffset: pos, dataBytes: evenBytes, sampleRate: TARGET_RATE };
      }
      pos += chunkSize + (chunkSize & 1);
    }
    return null;
  } finally {
    closeSync(fd);
  }
}

function runConverter(cmd, args, spawnImpl = spawn) {
  return new Promise((resolveConv, rejectConv) => {
    const proc = spawnImpl(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr?.on('data', (c) => { stderr += c.toString('utf8'); });
    proc.on('error', (err) => rejectConv(err));
    proc.on('close', (code) => {
      if (code === 0) resolveConv();
      else rejectConv(new Error(stderr.trim() || `${cmd} exit ${code}`));
    });
  });
}

async function convertToStandardWav(srcPath, destWavPath, { platform = process.platform, spawnImpl = spawn } = {}) {
  const attempts = [];
  if (platform === 'darwin') {
    attempts.push(['afconvert', ['-f', 'WAVE', '-d', `LEI16@${TARGET_RATE}`, '-c', '1', srcPath, destWavPath]]);
  }
  attempts.push(['ffmpeg', ['-y', '-i', srcPath, '-ac', '1', '-ar', String(TARGET_RATE), '-f', 'wav', '-acodec', 'pcm_s16le', destWavPath]]);

  let lastErr = null;
  for (const [cmd, args] of attempts) {
    try {
      await runConverter(cmd, args, spawnImpl);
      if (inspectStandardPcmWav(destWavPath)) return destWavPath;
    } catch (err) {
      lastErr = err;
    }
  }
  throw new ApiError(
    `无法转换音频格式（需要本机支持 ${platform === 'darwin' ? 'afconvert 或 ' : ''}ffmpeg，或直接导入 16kHz 单声道 WAV 文件）。`,
    { code: 'AUDIO_CONVERT_FAILED' },
  );
}

function slicePcmWavToMeetingDir(wavPath, info, outDir, startedAtIso) {
  const bytesPerSegment = TARGET_RATE * 2 * SEGMENT_SECONDS;
  const segments = [];
  const fd = openSync(wavPath, 'r');
  try {
    let offset = 0;
    let index = 1;
    while (offset < info.dataBytes) {
      const len = Math.min(bytesPerSegment, info.dataBytes - offset);
      const pcm = Buffer.alloc(len);
      const read = readSync(fd, pcm, 0, len, info.dataOffset + offset);
      const evenRead = read - (read % 2);
      if (evenRead <= 0) break;
      const filename = `mic-${String(index).padStart(4, '0')}.wav`;
      const startMs = Math.round((offset / (TARGET_RATE * 2)) * 1000);
      const endMs = Math.round(((offset + evenRead) / (TARGET_RATE * 2)) * 1000);
      writeFileSync(join(outDir, filename), Buffer.concat([writeWavHeader(evenRead, TARGET_RATE), pcm.subarray(0, evenRead)]));
      segments.push({ index, startMs, endMs, mic: filename, system: null });
      offset += evenRead;
      index += 1;
    }
  } finally {
    closeSync(fd);
  }

  const durationMs = segments.length ? segments[segments.length - 1].endMs : 0;
  const manifest = {
    version: 1,
    startedAt: startedAtIso,
    sampleRate: TARGET_RATE,
    segmentSeconds: SEGMENT_SECONDS,
    tracks: ['mic'],
    status: 'stopped',
    durationMs,
    segments,
    marks: [],
    paused: [],
  };
  writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return { durationMs, segmentsCount: segments.length };
}

export function createAudioImporter({ paths, platform = process.platform, spawnImpl = spawn, now = () => Date.now() } = {}) {
  async function importAudio({ filePath, title = '', source = 'offline', workspaceDir = '' } = {}) {
    if (typeof filePath !== 'string' || !filePath.trim()) {
      throw new ApiError('请提供要导入的本地音频文件路径。', { code: 'INVALID_REQUEST' });
    }
    let realPath;
    let st;
    try {
      realPath = realpathSync(filePath.trim());
      st = statSync(realPath);
    } catch {
      throw new ApiError('找不到指定的音频文件，请检查路径是否存在。', { code: 'FILE_NOT_FOUND' });
    }
    if (!st.isFile()) {
      throw new ApiError('指定路径不是有效的音频文件。', { code: 'INVALID_REQUEST' });
    }
    const ext = extname(realPath).toLowerCase();
    if (!ALLOWED_AUDIO_EXTENSIONS.has(ext)) {
      throw new ApiError(`不支持的音频格式「${ext || '无扩展名'}」，支持 WAV/M4A/MP3/FLAC/OGG/AAC/MP4/WEBM。`, {
        code: 'UNSUPPORTED_FORMAT',
      });
    }
    if (st.size <= 0 || st.size > MAX_IMPORT_BYTES) {
      throw new ApiError('音频文件为空或超过 500 MB 导入上限。', { code: 'FILE_TOO_LARGE' });
    }

    const stamp = now();
    const meetingId = `imp-${stamp}`;
    const recordingsRoot = paths.resolveRecordingsDir({ workspaceDir, ensure: true });
    const outDir = join(recordingsRoot, meetingId);
    mkdirSync(outDir, { recursive: true, mode: 0o755 });

    const startedAt = new Date(stamp).toISOString();
    let tempConverted = '';
    try {
      let wavPath = realPath;
      let info = ext === '.wav' ? inspectStandardPcmWav(realPath) : null;
      if (!info) {
        tempConverted = join(tmpdir(), `echomind-import-${randomUUID()}.wav`);
        await convertToStandardWav(realPath, tempConverted, { platform, spawnImpl });
        wavPath = tempConverted;
        info = inspectStandardPcmWav(wavPath);
      }
      if (!info || info.dataBytes <= 0) {
        throw new ApiError('音频文件不包含有效的声音数据。', { code: 'EMPTY_AUDIO' });
      }
      const { durationMs, segmentsCount } = slicePcmWavToMeetingDir(wavPath, info, outDir, startedAt);
      const fallbackTitle = basename(realPath, ext).trim() || '导入的会议录音';
      return {
        meetingId,
        outDir,
        title: String(title || '').trim() || fallbackTitle,
        source: source || 'offline',
        startedAt,
        durationMs,
        segments: segmentsCount,
      };
    } catch (error) {
      try { rmSync(outDir, { recursive: true, force: true }); } catch {}
      throw error;
    } finally {
      if (tempConverted) {
        try { rmSync(tempConverted, { force: true }); } catch {}
      }
    }
  }

  return { importAudio };
}
