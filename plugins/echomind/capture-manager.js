import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { ApiError } from './api-client.js';

// echomind-capture 原生双轨录音 sidecar 管理器（Swift macOS / Rust WASAPI Windows）。
// 协议遵循 native/macos-capture/README.md：
// - stdin 一行一个指令：pause / resume / mark / stop（保持 stdin 打开，EOF 即停止）；
// - stdout 一行一个 JSON 事件：started / level / segment / mark / paused / resumed / device-changed / error / stopped。

const ONE_SHOT_TIMEOUT_MS = 15_000;
const PERMISSION_PROMPT_TIMEOUT_MS = 120_000;
const STOP_GRACE_MS = 5000;

export function createCaptureManager({
  binaryManager,
  paths,
  platform = process.platform,
  spawnImpl = spawn,
  onRecordingStarted = () => {},
  onRecordingStopped = () => {},
  onStateChange = () => {},
  now = () => Date.now(),
} = {}) {
  let child = null;
  let stopPromise = null;
  let active = null;

  function requireCaptureBinary() {
    const info = binaryManager.resolveBinary('capture');
    if (!info.supported) {
      throw new ApiError('当前操作系统暂不支持双轨会议录音，目前仅支持 macOS 14.2+ 和 Windows。', {
        code: 'UNSUPPORTED_PLATFORM',
      });
    }
    if (!info.ready || !info.path) {
      throw new ApiError('尚未安装双轨录音模块（echomind-capture），请先在「EchoMind 会议配置」中一键安装或检查 ECHOMIND_BIN_DIR。', {
        code: 'BINARY_MISSING',
      });
    }
    return info.path;
  }

  function runOneShot(args, { timeoutMs = ONE_SHOT_TIMEOUT_MS, signal } = {}) {
    const bin = requireCaptureBinary();
    return new Promise((resolveRun, rejectRun) => {
      const proc = spawnImpl(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let settled = false;

      const finish = (err, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        if (err) rejectRun(err);
        else resolveRun(value);
      };

      proc.stdout?.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
      proc.stderr?.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

      proc.on('error', () => {
        finish(new ApiError('无法启动录音模块，请检查文件权限或重新安装。', { code: 'SPAWN_FAILED' }));
      });
      proc.on('close', (code) => {
        const trimmed = stdout.trim();
        let parsed = null;
        if (trimmed) {
          const lines = trimmed.split(/\r?\n/u).filter(Boolean);
          for (let i = lines.length - 1; i >= 0; i -= 1) {
            try {
              parsed = JSON.parse(lines[i]);
              break;
            } catch {
              // Keep searching earlier line.
            }
          }
        }
        if (code === 0 && parsed) {
          finish(null, parsed);
          return;
        }
        if (parsed?.type === 'error' && parsed.message) {
          finish(new ApiError(parsed.message, { code: String(parsed.code || 'CAPTURE_ERROR').toUpperCase() }));
          return;
        }
        finish(
          new ApiError(
            stderr.trim() || `录音模块执行失败（退出码 ${code ?? '未知'}）。`,
            { code: 'CAPTURE_ERROR' },
          ),
        );
      });

      const onAbort = () => {
        try { proc.kill('SIGTERM'); } catch {}
        finish(new ApiError('操作已取消。', { code: 'CANCELLED' }));
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
        finish(new ApiError('录音模块响应超时，请重试。', { code: 'TIMEOUT' }));
      }, timeoutMs);
      timer.unref?.();
    });
  }

  function checkPermissions(signal) {
    return runOneShot(['permissions'], { signal });
  }

  function requestPermission(kind, signal) {
    if (kind === 'mic' || kind === 'microphone') {
      return runOneShot(['permissions', '--request-mic'], { timeoutMs: PERMISSION_PROMPT_TIMEOUT_MS, signal });
    }
    if (kind === 'systemAudio') {
      return runOneShot(['permissions', '--request-system-audio'], { timeoutMs: PERMISSION_PROMPT_TIMEOUT_MS, signal });
    }
    throw new ApiError('未知的权限类型。', { code: 'INVALID_REQUEST' });
  }

  function openPrivacySettings(kind) {
    if (platform === 'darwin') {
      const target =
        kind === 'systemAudio'
          ? 'x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent'
          : 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone';
      const url =
        kind === 'systemAudio'
          ? 'x-apple.systempreferences:com.apple.preference.security?Privacy_AudioCapture'
          : target;
      const p = spawnImpl('open', [url], { stdio: 'ignore', detached: true });
      p.unref?.();
      return { ok: true, opened: url };
    }
    if (platform === 'win32') {
      const url = 'ms-settings:privacy-microphone';
      const p = spawnImpl('rundll32.exe', ['url.dll,FileProtocolHandler', url], { stdio: 'ignore', detached: true });
      p.unref?.();
      return { ok: true, opened: url };
    }
    throw new ApiError('当前系统暂不支持自动打开隐私设置页面。', { code: 'UNSUPPORTED_PLATFORM' });
  }

  function listDevices(signal) {
    return runOneShot(['devices'], { signal });
  }

  async function detectMeetings(signal) {
    const res = await runOneShot(['meetings'], { signal });
    return Array.isArray(res?.meetings) ? res.meetings : [];
  }

  function getSnapshot() {
    if (!active) return null;
    return {
      meetingId: active.meetingId,
      outDir: active.outDir,
      source: active.source,
      title: active.title,
      startedAt: active.startedAt,
      elapsedMs: active.elapsedMs,
      paused: active.paused,
      micDb: active.micDb,
      systemDb: active.systemDb,
      micDevice: active.micDevice,
      systemDevice: active.systemDevice,
      marks: [...active.marks],
      segments: active.segments,
      warnings: [...active.warnings],
      lastError: active.lastError,
      stopping: active.stopping,
    };
  }

  function emitChange() {
    onStateChange(getSnapshot());
  }

  async function startRecording({
    title = '',
    source = 'other',
    workspaceDir = '',
    micDevice = '',
    systemPids = null,
    noSystem = false,
    noMic = false,
    segmentSeconds = 60,
    sampleRate = 16000,
    skipPermissionCheck = false,
    signal,
  } = {}) {
    if (child || active) {
      throw new ApiError('当前已经有一场会议正在录音中，请先结束当前录音。', { code: 'ALREADY_RECORDING' });
    }
    const bin = requireCaptureBinary();

    const warnings = [];
    if (!skipPermissionCheck && !noMic && !noSystem) {
      let perms = await checkPermissions(signal);
      if (perms?.microphone === 'undetermined') {
        perms = await requestPermission('mic', signal);
      }
      if (perms?.microphone === 'denied' || perms?.microphone === 'restricted') {
        throw new ApiError(
          '没有麦克风录音权限：请到「系统设置 → 隐私与安全性 → 麦克风」中允许小智办公访问麦克风后重试。',
          { code: 'MIC_PERMISSION_DENIED' },
        );
      }
      if (perms?.systemAudio === 'undetermined') {
        try {
          perms = await requestPermission('systemAudio', signal);
        } catch {
          // Best-effort request.
        }
      }
      if (perms?.systemAudio === 'denied') {
        warnings.push('系统录音权限未开启：本次只会录到你的麦克风，线上参会人的声音可能录不到。');
      }
    }

    const meetingId = `rec-${now()}`;
    const recordingsRoot = paths.resolveRecordingsDir({ workspaceDir, ensure: true });
    const outDir = join(recordingsRoot, meetingId);
    mkdirSync(outDir, { recursive: true, mode: 0o755 });

    const args = [
      'record',
      '--out',
      outDir,
      '--segment-seconds',
      String(segmentSeconds),
      '--sample-rate',
      String(sampleRate),
    ];
    if (micDevice) args.push('--mic-device', String(micDevice));
    if (Array.isArray(systemPids) && systemPids.length > 0 && platform === 'darwin') {
      args.push('--system-pids', systemPids.map((n) => String(n)).join(','));
    }
    if (noSystem) args.push('--no-system');
    if (noMic) args.push('--no-mic');

    const proc = spawnImpl(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    child = proc;

    active = {
      meetingId,
      outDir,
      source: source || 'other',
      title: String(title || '').trim(),
      startedAt: new Date(now()).toISOString(),
      elapsedMs: 0,
      paused: false,
      micDb: -90,
      systemDb: -90,
      micDevice: '',
      systemDevice: '',
      marks: [],
      segments: 0,
      warnings,
      lastError: null,
      stopping: false,
    };

    const startedPromise = new Promise((resolveStarted, rejectStarted) => {
      let startedSettled = false;
      let stoppedPayload = null;
      let lastStderr = '';

      const settleStart = (err, val) => {
        if (startedSettled) return;
        startedSettled = true;
        if (err) rejectStarted(err);
        else resolveStarted(val);
      };

      const rl = createInterface({ input: proc.stdout });
      rl.on('line', (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let event;
        try {
          event = JSON.parse(trimmed);
        } catch {
          return;
        }
        if (!active) return;

        switch (event.type) {
          case 'started': {
            if (typeof event.startedAt === 'string') active.startedAt = event.startedAt;
            active.micDevice = event.mic?.device || '';
            active.systemDevice = event.system?.device || '';
            const snap = getSnapshot();
            onRecordingStarted(snap);
            emitChange();
            settleStart(null, snap);
            break;
          }
          case 'level': {
            if (typeof event.t === 'number') active.elapsedMs = event.t;
            if (typeof event.mic === 'number') active.micDb = event.mic;
            if (typeof event.system === 'number') active.systemDb = event.system;
            emitChange();
            break;
          }
          case 'segment': {
            if (typeof event.index === 'number') active.segments = event.index;
            if (typeof event.endMs === 'number') active.elapsedMs = Math.max(active.elapsedMs, event.endMs);
            emitChange();
            break;
          }
          case 'mark': {
            if (typeof event.atMs === 'number') active.marks.push({ atMs: event.atMs });
            emitChange();
            break;
          }
          case 'paused': {
            active.paused = true;
            active.micDb = -90;
            active.systemDb = -90;
            emitChange();
            break;
          }
          case 'resumed': {
            active.paused = false;
            emitChange();
            break;
          }
          case 'device-changed': {
            if (event.track === 'mic' && typeof event.device === 'string') active.micDevice = event.device;
            if (event.track === 'system' && typeof event.device === 'string') active.systemDevice = event.device;
            emitChange();
            break;
          }
          case 'error': {
            const msg = typeof event.message === 'string' && event.message.trim() ? event.message.trim() : '录音过程出现异常。';
            active.lastError = { code: event.code || 'capture_error', message: msg };
            if (!startedSettled && ['output_dir_unwritable', 'write_failed', 'resample_failed', 'invalid_arguments'].includes(event.code)) {
              settleStart(new ApiError(msg, { code: String(event.code).toUpperCase() }));
            } else if (!active.warnings.includes(msg)) {
              active.warnings.push(msg);
            }
            emitChange();
            break;
          }
          case 'stopped': {
            stoppedPayload = {
              meetingId: active.meetingId,
              outDir: active.outDir,
              source: active.source,
              title: active.title,
              startedAt: active.startedAt,
              durationMs: typeof event.durationMs === 'number' ? event.durationMs : active.elapsedMs,
              segments: typeof event.segments === 'number' ? event.segments : active.segments,
              marks: [...active.marks],
            };
            break;
          }
          default:
            break;
        }
      });

      proc.stderr?.on('data', (chunk) => {
        const text = chunk.toString('utf8').trim();
        if (text) lastStderr = text;
      });

      proc.on('error', () => {
        child = null;
        active = null;
        emitChange();
        settleStart(new ApiError('启动录音进程失败，请确认录音模块完整。', { code: 'SPAWN_FAILED' }));
      });

      proc.on('close', (code) => {
        rl.close();
        const finalInfo = stoppedPayload || (active
          ? {
              meetingId: active.meetingId,
              outDir: active.outDir,
              source: active.source,
              title: active.title,
              startedAt: active.startedAt,
              durationMs: active.elapsedMs,
              segments: active.segments,
              marks: [...active.marks],
              abnormalExitCode: code,
            }
          : null);
        child = null;
        active = null;
        stopPromise = null;
        emitChange();
        if (!startedSettled) {
          settleStart(
            new ApiError(lastStderr || `录音进程提前退出（退出码 ${code ?? '未知'}）。`, {
              code: 'CAPTURE_EXITED',
            }),
          );
        }
        if (finalInfo && startedSettled && (stoppedPayload || finalInfo.durationMs > 0 || finalInfo.segments > 0)) {
          onRecordingStopped(finalInfo);
        }
      });
    });

    return startedPromise;
  }

  async function sendCommand(command) {
    const normalized = String(command || '').trim().toLowerCase();
    if (!['pause', 'resume', 'mark', 'stop'].includes(normalized)) {
      throw new ApiError(`不支持的录音指令：${command}`, { code: 'INVALID_REQUEST' });
    }
    if (!child || !active) {
      throw new ApiError('当前没有正在进行的会议录音。', { code: 'NOT_RECORDING' });
    }
    if (normalized === 'stop') {
      return stopRecording();
    }
    try {
      child.stdin.write(`${normalized}\n`);
    } catch {
      throw new ApiError('无法向录音进程发送控制指令。', { code: 'CAPTURE_IO_ERROR' });
    }
    return getSnapshot();
  }

  async function stopRecording() {
    if (!child || !active) return null;
    if (stopPromise) return stopPromise;
    active.stopping = true;
    emitChange();
    const targetProc = child;
    const summaryBefore = getSnapshot();

    stopPromise = new Promise((resolveStop) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        resolveStop(summaryBefore);
      };
      targetProc.once('close', done);
      try {
        targetProc.stdin.write('stop\n');
      } catch {
        try { targetProc.kill('SIGTERM'); } catch {}
      }
      const killTimer = setTimeout(() => {
        try { targetProc.kill('SIGKILL'); } catch {}
        done();
      }, STOP_GRACE_MS);
      killTimer.unref?.();
    });

    return stopPromise;
  }

  async function dispose() {
    if (child && active) {
      await stopRecording();
    }
  }

  return {
    isRecording: () => Boolean(child && active),
    getSnapshot,
    checkPermissions,
    requestPermission,
    openPrivacySettings,
    listDevices,
    detectMeetings,
    startRecording,
    sendCommand,
    stopRecording,
    dispose,
  };
}
