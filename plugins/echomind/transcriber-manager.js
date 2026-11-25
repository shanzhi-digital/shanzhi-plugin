import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { ApiError } from './api-client.js';

// echomind-transcribe 本机离线转写与声纹提取管理器（Rust + sherpa-onnx）。
// - 单并发串行队列：单次转写峰值内存 ~550 MB，一次只跑一场会议；
// - 独立子进程运行：避免 onnxruntime 异常崩溃波及 DSH 主进程，跑完立即释放内存；
// - 声纹提取结果（192 维向量）仅在宿主内存流转，不落盘、不返回给前端或模型。

const MODELS_STATUS_TIMEOUT_MS = 15_000;
const VOICES_TIMEOUT_MS = 180_000;

export class ModelsMissingError extends ApiError {
  constructor(message) {
    super(message || '语音转写模型尚未下载完成，请先下载模型（约 200 MB）后再转写。', {
      code: 'MODELS_MISSING',
    });
    this.name = 'ModelsMissingError';
  }
}

export function createTranscriberManager({
  binaryManager,
  paths,
  getModelMirrorUrl = () => '',
  spawnImpl = spawn,
} = {}) {
  let queueTail = Promise.resolve();
  let downloadingPromise = null;
  let downloadProgress = null;
  const activeChildren = new Map();

  function requireTranscribeBinary() {
    const info = binaryManager.resolveBinary('transcribe');
    if (!info.supported) {
      throw new ApiError('当前操作系统暂不支持本机语音转写模块。', { code: 'UNSUPPORTED_PLATFORM' });
    }
    if (!info.ready || !info.path) {
      throw new ApiError('尚未安装本机语音转写模块（echomind-transcribe），请先在「EchoMind 会议配置」中一键安装或检查 ECHOMIND_BIN_DIR。', {
        code: 'BINARY_MISSING',
      });
    }
    return info.path;
  }

  function childEnv() {
    const mirror = String(getModelMirrorUrl() || '').trim();
    const env = { ...process.env, ECHOMIND_MODELS_DIR: paths.modelsDir };
    if (mirror) env.ECHOMIND_MODEL_MIRROR = mirror;
    return env;
  }

  function checkModels(signal) {
    const bin = requireTranscribeBinary();
    return new Promise((resolveModels, rejectModels) => {
      const proc = spawnImpl(bin, ['models', '--models-dir', paths.modelsDir], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: childEnv(),
      });
      let stdout = '';
      let stderr = '';
      let settled = false;

      const finish = (err, val) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        if (err) rejectModels(err);
        else resolveModels(val);
      };

      proc.stdout?.on('data', (c) => { stdout += c.toString('utf8'); });
      proc.stderr?.on('data', (c) => { stderr += c.toString('utf8'); });
      proc.on('error', () => finish(new ApiError('无法启动本机转写模块。', { code: 'SPAWN_FAILED' })));
      proc.on('close', (code) => {
        try {
          const parsed = JSON.parse(stdout.trim());
          finish(null, parsed);
        } catch {
          finish(new ApiError(stderr.trim() || `读取转写模型状态失败（退出码 ${code ?? '未知'}）。`, { code: 'TRANSCRIBE_ERROR' }));
        }
      });

      const onAbort = () => {
        try { proc.kill('SIGTERM'); } catch {}
        finish(new ApiError('已取消操作。', { code: 'CANCELLED' }));
      };
      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }
      const timer = setTimeout(() => {
        try { proc.kill('SIGTERM'); } catch {}
        finish(new ApiError('查询语音模型状态超时。', { code: 'TIMEOUT' }));
      }, MODELS_STATUS_TIMEOUT_MS);
      timer.unref?.();
    });
  }

  function downloadModels({ onProgress, signal } = {}) {
    if (downloadingPromise) return downloadingPromise;
    const bin = requireTranscribeBinary();

    downloadingPromise = new Promise((resolveDl, rejectDl) => {
      paths.ensureDir(paths.modelsDir, 0o755);
      const proc = spawnImpl(bin, ['download', '--json', '--models-dir', paths.modelsDir], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: childEnv(),
      });
      let lastStderr = '';
      let settled = false;
      const finish = (err, val) => {
        if (settled) return;
        settled = true;
        if (signal) signal.removeEventListener('abort', onAbort);
        downloadProgress = null;
        downloadingPromise = null;
        if (err) rejectDl(err);
        else resolveDl(val);
      };

      const rl = createInterface({ input: proc.stdout });
      rl.on('line', (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let event;
        try { event = JSON.parse(trimmed); } catch { return; }
        if (event.type === 'download') {
          downloadProgress = { received: Number(event.received) || 0, total: Number(event.total) || 0 };
          if (typeof onProgress === 'function') onProgress(downloadProgress);
        } else if (event.type === 'done') {
          finish(null, event.status || { ready: true });
        } else if (event.type === 'error') {
          finish(new ApiError(event.message || '下载语音模型失败。', { code: String(event.kind || 'DOWNLOAD_FAILED').toUpperCase() }));
        }
      });

      proc.stderr?.on('data', (c) => {
        const t = c.toString('utf8').trim();
        if (t) lastStderr = t;
      });
      proc.on('error', () => finish(new ApiError('启动模型下载进程失败。', { code: 'SPAWN_FAILED' })));
      proc.on('close', (code) => {
        rl.close();
        if (!settled) {
          finish(new ApiError(lastStderr || `模型下载进程提前退出（退出码 ${code ?? '未知'}）。`, { code: 'DOWNLOAD_FAILED' }));
        }
      });

      const onAbort = () => {
        try { proc.stdin.write('cancel\n'); } catch {}
        try { proc.kill('SIGTERM'); } catch {}
        finish(new ApiError('已取消模型下载。', { code: 'CANCELLED' }));
      };
      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });

    return downloadingPromise;
  }

  function runSingleTranscribe(meetingId, meetingDir, { scene, speakers, onProgress, signal } = {}) {
    const bin = requireTranscribeBinary();
    if (!existsSync(join(meetingDir, 'manifest.json'))) {
      throw new ApiError('找不到该会议的录音清单（manifest.json），录音可能已被移走或删除。', { code: 'RECORDING_MISSING' });
    }
    const args = ['run', meetingDir, '--json', '--models-dir', paths.modelsDir, '--out', join(meetingDir, 'transcript.json')];
    if (scene) {
      if (scene !== 'in-person' && scene !== 'online') {
        throw new ApiError('会议场景只支持 in-person（面对面）或 online（线上）。', { code: 'INVALID_REQUEST' });
      }
      args.push('--scene', scene);
    }
    if (speakers !== undefined && speakers !== null) {
      const n = Number(speakers);
      if (!Number.isInteger(n) || n < 1 || n > 20) {
        throw new ApiError('说话人数须为 1 到 20 之间的整数。', { code: 'INVALID_REQUEST' });
      }
      args.push('--speakers', String(n));
    }

    return new Promise((resolveRun, rejectRun) => {
      const proc = spawnImpl(bin, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: childEnv(),
      });
      activeChildren.set(meetingId, proc);
      let lastStderr = '';
      let settled = false;

      const finish = (err, val) => {
        if (settled) return;
        settled = true;
        activeChildren.delete(meetingId);
        if (signal) signal.removeEventListener('abort', onAbort);
        if (err) rejectRun(err);
        else resolveRun(val);
      };

      const rl = createInterface({ input: proc.stdout });
      rl.on('line', (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let event;
        try { event = JSON.parse(trimmed); } catch { return; }
        if (event.type === 'progress') {
          if (typeof onProgress === 'function') {
            onProgress({ stage: event.stage || 'prepare', progress: Number(event.progress) || 0 });
          }
        } else if (event.type === 'done' && event.transcript) {
          finish(null, event.transcript);
        } else if (event.type === 'error') {
          if (event.kind === 'models_missing') {
            finish(new ModelsMissingError(event.message));
          } else {
            finish(new ApiError(event.message || '本机转写失败。', { code: String(event.kind || 'TRANSCRIBE_ERROR').toUpperCase() }));
          }
        }
      });

      proc.stderr?.on('data', (c) => {
        const t = c.toString('utf8').trim();
        if (t) lastStderr = t;
      });
      proc.on('error', () => finish(new ApiError('启动本机转写进程失败。', { code: 'SPAWN_FAILED' })));
      proc.on('close', (code) => {
        rl.close();
        if (!settled) {
          finish(new ApiError(lastStderr || `本机转写进程异常退出（退出码 ${code ?? '未知'}）。`, { code: 'TRANSCRIBE_ERROR' }));
        }
      });

      const onAbort = () => {
        try { proc.stdin.write('cancel\n'); } catch {}
        try { proc.kill('SIGTERM'); } catch {}
        finish(new ApiError('已取消转写。', { code: 'CANCELLED' }));
      };
      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  /** 串行排队执行单场会议转写。 */
  function transcribe(meetingId, meetingDir, options = {}) {
    const task = queueTail.then(
      () => runSingleTranscribe(meetingId, meetingDir, options),
      () => runSingleTranscribe(meetingId, meetingDir, options),
    );
    queueTail = task.catch(() => {});
    return task;
  }

  /** 提取已转写会议的说话人声纹向量（仅在宿主内存流转）。 */
  function extractVoices(meetingDir, { signal } = {}) {
    const bin = requireTranscribeBinary();
    if (!existsSync(join(meetingDir, 'transcript.json'))) {
      throw new ApiError('该会议尚未完成转写，无法提取声纹特征。', { code: 'TRANSCRIPT_MISSING' });
    }
    return new Promise((resolveVoices, rejectVoices) => {
      const proc = spawnImpl(bin, ['voices', meetingDir, '--json', '--models-dir', paths.modelsDir], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: childEnv(),
      });
      let lastStderr = '';
      let settled = false;
      const finish = (err, val) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        if (err) rejectVoices(err);
        else resolveVoices(val);
      };

      const rl = createInterface({ input: proc.stdout });
      rl.on('line', (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let event;
        try { event = JSON.parse(trimmed); } catch { return; }
        if (event.type === 'done' && Array.isArray(event.voices)) {
          finish(null, event.voices);
        } else if (event.type === 'error') {
          if (event.kind === 'models_missing') finish(new ModelsMissingError(event.message));
          else finish(new ApiError(event.message || '提取声纹特征失败。', { code: String(event.kind || 'VOICES_ERROR').toUpperCase() }));
        }
      });

      proc.stderr?.on('data', (c) => {
        const t = c.toString('utf8').trim();
        if (t) lastStderr = t;
      });
      proc.on('error', () => finish(new ApiError('启动声纹提取进程失败。', { code: 'SPAWN_FAILED' })));
      proc.on('close', (code) => {
        rl.close();
        if (!settled) {
          finish(new ApiError(lastStderr || `声纹提取异常退出（退出码 ${code ?? '未知'}）。`, { code: 'VOICES_ERROR' }));
        }
      });

      const onAbort = () => {
        try { proc.stdin.write('cancel\n'); } catch {}
        try { proc.kill('SIGTERM'); } catch {}
        finish(new ApiError('已取消声纹提取。', { code: 'CANCELLED' }));
      };
      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }
      const timer = setTimeout(() => {
        try { proc.kill('SIGTERM'); } catch {}
        finish(new ApiError('提取声纹特征超时。', { code: 'TIMEOUT' }));
      }, VOICES_TIMEOUT_MS);
      timer.unref?.();
    });
  }

  function dispose() {
    for (const proc of activeChildren.values()) {
      try { proc.stdin.write('cancel\n'); } catch {}
      try { proc.kill('SIGTERM'); } catch {}
    }
    activeChildren.clear();
  }

  return {
    checkModels,
    downloadModels,
    getDownloadProgress: () => downloadProgress,
    transcribe,
    extractVoices,
    dispose,
  };
}
