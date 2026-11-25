import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApiError } from './api-client.js';

// 原生二进制（echomind-capture / echomind-transcribe）定位、SHA-256 校验与按需镜像下载。
// 查找优先级：
//   1. 环境变量 ECHOMIND_BIN_DIR（开发联调指向 erji/apps/desktop/src-tauri/binaries）；
//   2. DSH 工作区/数据区 <dataRoot>/bin/<platform>-<arch>/<filename>；
//   3. 本机已安装独立版 EchoMind App 中的只读二进制（若存在）。
// 下载后先落临时文件 → 校验 SHA-256（若 manifest 登记了哈希）→ chmod 0755 → 原子重命名。

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_MANIFEST_PATH = join(__dirname, 'runtime-manifest.json');
const MAX_REDIRECTS = 5;
const DOWNLOAD_TIMEOUT_MS = 180_000;

export function platformKey(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`;
}

export function loadRuntimeManifest(manifestPath = DEFAULT_MANIFEST_PATH) {
  const raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
  return raw && typeof raw === 'object' ? raw : { version: '0.0.0', platforms: {} };
}

export function sha256File(filePath) {
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolveHash(hash.digest('hex')));
    stream.on('error', rejectHash);
  });
}

function isExecutableFile(filePath) {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function downloadStreamToFile(urlString, destPath, { onProgress, signal, redirects = 0 } = {}) {
  return new Promise((resolveDl, rejectDl) => {
    let parsed;
    try {
      parsed = new URL(urlString);
    } catch {
      rejectDl(new ApiError('二进制下载地址格式无效。', { code: 'INVALID_URL' }));
      return;
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      rejectDl(new ApiError('二进制下载地址必须是 http:// 或 https://。', { code: 'INVALID_URL' }));
      return;
    }
    const reqFn = parsed.protocol === 'https:' ? httpsRequest : httpRequest;

    let settled = false;
    const finish = (err, res) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (err) rejectDl(err);
      else resolveDl(res);
    };

    const req = reqFn(parsed, { method: 'GET' }, (res) => {
      const status = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
        res.resume();
        if (redirects >= MAX_REDIRECTS) {
          finish(new ApiError('下载二进制时重定向次数过多。', { code: 'DOWNLOAD_FAILED' }));
          return;
        }
        const nextUrl = new URL(res.headers.location, parsed).href;
        downloadStreamToFile(nextUrl, destPath, { onProgress, signal, redirects: redirects + 1 })
          .then((r) => finish(null, r))
          .catch((e) => finish(e));
        return;
      }
      if (status < 200 || status >= 300) {
        res.resume();
        finish(new ApiError(`下载二进制失败（HTTP ${status}）。`, { code: 'DOWNLOAD_FAILED', status }));
        return;
      }
      const total = Number(res.headers['content-length']) || 0;
      let received = 0;
      mkdirSync(dirname(destPath), { recursive: true, mode: 0o755 });
      const file = createWriteStream(destPath, { mode: 0o700 });
      res.on('data', (chunk) => {
        received += chunk.length;
        if (typeof onProgress === 'function') onProgress({ received, total });
      });
      res.pipe(file);
      file.on('finish', () => {
        file.close(() => finish(null, { received, total: total || received }));
      });
      file.on('error', () => {
        finish(new ApiError('写入本地二进制文件失败，请检查磁盘空间与权限。', { code: 'IO_ERROR' }));
      });
      res.on('error', () => {
        file.destroy();
        finish(new ApiError('下载二进制时网络连接中断，请重试。', { code: 'DOWNLOAD_FAILED' }));
      });
    });

    const onAbort = () => {
      req.destroy();
      finish(new ApiError('已取消下载。', { code: 'CANCELLED' }));
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    const timer = setTimeout(() => {
      req.destroy();
      finish(new ApiError('下载二进制超时，请检查网络或镜像地址。', { code: 'TIMEOUT' }));
    }, DOWNLOAD_TIMEOUT_MS);
    timer.unref?.();

    req.on('error', () => {
      finish(new ApiError('无法连接二进制镜像服务器，请检查网络或配置。', { code: 'DOWNLOAD_FAILED' }));
    });
    req.end();
  });
}

export function createBinaryManager({
  paths,
  getMirrorUrl = () => '',
  manifestPath = DEFAULT_MANIFEST_PATH,
  platform = process.platform,
  arch = process.arch,
  envBinDir = () => process.env.ECHOMIND_BIN_DIR || '',
  extraSearchDirs = null,
  downloader = downloadStreamToFile,
} = {}) {
  const key = platformKey(platform, arch);
  const manifest = loadRuntimeManifest(manifestPath);
  const platformSpec = manifest.platforms?.[key] || null;
  let installing = null;
  let installProgress = null;

  function installedBinDir() {
    return join(paths.binRoot, key);
  }

  function defaultExternalDirs() {
    if (Array.isArray(extraSearchDirs)) return extraSearchDirs;
    const dirs = [];
    if (platform === 'darwin') {
      dirs.push('/Applications/EchoMind.app/Contents/MacOS');
    } else if (platform === 'win32' && process.env.LOCALAPPDATA) {
      dirs.push(join(process.env.LOCALAPPDATA, 'EchoMind'));
    }
    return dirs;
  }

  function resolveBinary(kind) {
    if (!platformSpec || !platformSpec[kind]) {
      return {
        kind,
        ready: false,
        supported: false,
        path: null,
        source: 'unsupported',
        spec: null,
      };
    }
    const spec = platformSpec[kind];
    const names = [spec.filename, spec.artifact].filter(Boolean);

    // 1. 环境变量覆盖目录（开发联调优先）
    const envDir = String(envBinDir() || '').trim();
    if (envDir) {
      for (const name of names) {
        const candidate = resolve(join(envDir, name));
        if (isExecutableFile(candidate)) {
          return { kind, ready: true, supported: true, path: candidate, source: 'env', spec };
        }
      }
    }

    // 2. DSH 工作区/数据区 bin/<platform>-<arch>/
    const managedDir = installedBinDir();
    for (const name of names) {
      const candidate = join(managedDir, name);
      if (isExecutableFile(candidate)) {
        return { kind, ready: true, supported: true, path: candidate, source: 'dsh-bin', spec };
      }
    }

    // 3. 已安装独立版 EchoMind 的可复用二进制
    for (const extDir of defaultExternalDirs()) {
      for (const name of names) {
        const candidate = join(extDir, name);
        if (isExecutableFile(candidate)) {
          return { kind, ready: true, supported: true, path: candidate, source: 'echomind-app', spec };
        }
      }
    }

    return { kind, ready: false, supported: true, path: null, source: 'missing', spec };
  }

  function getStatus() {
    const capture = resolveBinary('capture');
    const transcribe = resolveBinary('transcribe');
    return {
      platform: key,
      supported: Boolean(platformSpec),
      ready: capture.ready && transcribe.ready,
      installing: Boolean(installing),
      installProgress,
      binDir: installedBinDir(),
      modelsDir: paths.modelsDir,
      capture: {
        ready: capture.ready,
        source: capture.source,
        path: capture.path,
        bytes: capture.spec?.bytes || 0,
      },
      transcribe: {
        ready: transcribe.ready,
        source: transcribe.source,
        path: transcribe.path,
        bytes: transcribe.spec?.bytes || 0,
      },
    };
  }

  async function installOne(kind, { mirrorUrl, onProgress, signal } = {}) {
    const existing = resolveBinary(kind);
    if (!existing.supported || !existing.spec) {
      throw new ApiError(`当前平台（${key}）暂不支持 ${kind} 原生模块。`, { code: 'UNSUPPORTED_PLATFORM' });
    }
    const base = String(mirrorUrl || getMirrorUrl() || '').trim().replace(/\/+$/u, '');
    if (!base) {
      throw new ApiError(
        '尚未配置 EchoMind 原生组件镜像地址：请在「设置 → EchoMind 会议配置 → 高级设置」填写二进制镜像地址，或设置环境变量 ECHOMIND_BIN_DIR 指向本地编译目录。',
        { code: 'MIRROR_NOT_CONFIGURED' },
      );
    }

    const spec = existing.spec;
    const downloadUrl = `${base}/${spec.artifact}`;
    const destDir = installedBinDir();
    mkdirSync(destDir, { recursive: true, mode: 0o755 });
    const destPath = join(destDir, spec.filename);
    const tmpPath = `${destPath}.${randomUUID()}.tmp`;

    try {
      await downloader(downloadUrl, tmpPath, {
        signal,
        onProgress: (p) => {
          installProgress = { kind, received: p.received, total: p.total || spec.bytes || 0 };
          if (typeof onProgress === 'function') onProgress(installProgress);
        },
      });
      if (spec.sha256) {
        const actual = await sha256File(tmpPath);
        if (actual.toLowerCase() !== spec.sha256.toLowerCase()) {
          throw new ApiError(`下载的 ${spec.filename} 校验和不一致，已拒绝安装以保障安全。`, {
            code: 'CHECKSUM_MISMATCH',
          });
        }
      }
      if (platform !== 'win32') {
        chmodSync(tmpPath, 0o755);
      }
      renameSync(tmpPath, destPath);
      return destPath;
    } catch (error) {
      try {
        if (existsSync(tmpPath)) rmSync(tmpPath, { force: true });
      } catch {
        // Ignore cleanup failure.
      }
      throw error;
    }
  }

  async function installMissing({ mirrorUrl, onProgress, signal } = {}) {
    if (installing) return installing;
    installing = (async () => {
      try {
        for (const kind of ['capture', 'transcribe']) {
          const info = resolveBinary(kind);
          if (!info.ready) {
            await installOne(kind, { mirrorUrl, onProgress, signal });
          }
        }
        return getStatus();
      } finally {
        installProgress = null;
        installing = null;
      }
    })();
    return installing;
  }

  return {
    platform: key,
    resolveBinary,
    getStatus,
    installMissing,
  };
}
