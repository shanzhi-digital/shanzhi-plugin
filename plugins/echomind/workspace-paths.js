import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

// DSH 全局插件数据区与会议工作区路径管理。
// - 静态重资产（二进制 bin/、~274 MB 语音模型 models/、非机密配置 config.json、通讯录缓存、声纹挂起队列）
//   统一落盘在 DSH 宿主数据区 dshHomePath('storages', 'echomind')（无宿主时回退 ~/.dsh/storages/echomind），
//   跨会话复用不重复下载。
// - 录音与会议目录（recordings/<meetingId>/）支持优先使用当前 DSH 工作区（<workspace>/.echomind/recordings）
//   或设置页指定的 recordingsDir，未指定工作区时回退到 DSH 全局数据区的 recordings/，并维护工作区索引
//   以便跨会话查找历史会议。

export const MEETING_ID_PATTERN = /^[A-Za-z0-9._-]{1,80}$/u;

export function validMeetingId(id) {
  return typeof id === 'string' && MEETING_ID_PATTERN.test(id) && id !== '.' && id !== '..';
}

export function resolveDshDataRoot(options = {}) {
  if (typeof options.dataRoot === 'string' && options.dataRoot.trim()) {
    return resolve(options.dataRoot.trim());
  }
  if (typeof process.env.ECHOMIND_DATA_DIR === 'string' && process.env.ECHOMIND_DATA_DIR.trim()) {
    return resolve(process.env.ECHOMIND_DATA_DIR.trim());
  }
  if (typeof options.dshHomePath === 'function') {
    try {
      const p = options.dshHomePath('storages', 'echomind');
      if (typeof p === 'string' && p.trim()) return resolve(p.trim());
    } catch {
      // Fallback below.
    }
  }
  return resolve(join(homedir(), '.dsh', 'storages', 'echomind'));
}

export function createWorkspacePaths(options = {}) {
  const dataRoot = resolveDshDataRoot(options);
  const indexPath = join(dataRoot, 'workspace-index.json');
  const getConfiguredRecordingsDir = typeof options.getConfiguredRecordingsDir === 'function'
    ? options.getConfiguredRecordingsDir
    : () => '';

  const ensureDir = (dir, mode = 0o700) => {
    mkdirSync(dir, { recursive: true, mode });
    return dir;
  };

  const defaultRecordingsDir = () => join(dataRoot, 'recordings');

  function readWorkspaceRoots() {
    try {
      const parsed = JSON.parse(readFileSync(indexPath, 'utf8'));
      if (!parsed || !Array.isArray(parsed.roots)) return [];
      return parsed.roots.filter((item) => typeof item === 'string' && item.trim() && isAbsolute(item));
    } catch {
      return [];
    }
  }

  function registerRecordingsRoot(dir) {
    if (typeof dir !== 'string' || !dir.trim()) return;
    const normalized = resolve(dir.trim());
    const current = readWorkspaceRoots();
    if (current.includes(normalized)) return;
    const next = [normalized, ...current].slice(0, 32);
    ensureDir(dirname(indexPath));
    const tmp = `${indexPath}.${randomUUID()}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ version: 1, roots: next }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, indexPath);
  }

  /**
   * 决定一场新录音或新建会议应写入的 recordings 根目录：
   * 1. 若用户在设置页显式配置了 recordingsDir，优先使用；
   * 2. 若传入了当前 DSH 会话工作区目录 workspaceDir，使用 <workspaceDir>/.echomind/recordings；
   * 3. 否则回退到 DSH 全局数据区 <dataRoot>/recordings。
   */
  function resolveRecordingsDir({ workspaceDir = '', ensure = false } = {}) {
    const configured = String(getConfiguredRecordingsDir() || '').trim();
    let target;
    if (configured) {
      target = resolve(configured);
    } else if (typeof workspaceDir === 'string' && workspaceDir.trim() && isAbsolute(workspaceDir.trim())) {
      target = resolve(join(workspaceDir.trim(), '.echomind', 'recordings'));
    } else {
      target = defaultRecordingsDir();
    }
    if (ensure) {
      ensureDir(target, 0o755);
      registerRecordingsRoot(target);
    }
    return target;
  }

  /** 列出所有已登记及默认的 recordings 根目录（去重、存在性过滤可选）。 */
  function listRecordingsRoots({ workspaceDir = '', onlyExisting = true } = {}) {
    const candidates = [];
    const push = (p) => {
      if (!p || typeof p !== 'string') return;
      const abs = resolve(p);
      if (!candidates.includes(abs)) candidates.push(abs);
    };
    const configured = String(getConfiguredRecordingsDir() || '').trim();
    if (configured) push(configured);
    if (typeof workspaceDir === 'string' && workspaceDir.trim() && isAbsolute(workspaceDir.trim())) {
      push(join(workspaceDir.trim(), '.echomind', 'recordings'));
    }
    push(defaultRecordingsDir());
    for (const root of readWorkspaceRoots()) push(root);
    return onlyExisting ? candidates.filter((dir) => existsSync(dir)) : candidates;
  }

  /** 安全定位某场会议目录（防止 ../ 目录穿越）。优先查找已存在的目录，找不到时落到目标 recordings 根。 */
  function resolveMeetingDir(meetingId, { workspaceDir = '', mustExist = false } = {}) {
    if (!validMeetingId(meetingId)) {
      throw new RangeError(`会议编号「${String(meetingId || '')}」不合法。`);
    }
    for (const root of listRecordingsRoots({ workspaceDir, onlyExisting: true })) {
      const candidate = resolve(join(root, meetingId));
      if (!candidate.startsWith(root + sep)) continue;
      if (existsSync(candidate)) return candidate;
    }
    if (mustExist) return null;
    const base = resolveRecordingsDir({ workspaceDir, ensure: false });
    const candidate = resolve(join(base, meetingId));
    if (!candidate.startsWith(base + sep)) {
      throw new RangeError('会议目录路径越界。');
    }
    return candidate;
  }

  return {
    dataRoot,
    configPath: join(dataRoot, 'config.json'),
    credentialsPath: join(dataRoot, 'credentials.json'),
    binRoot: join(dataRoot, 'bin'),
    modelsDir: join(dataRoot, 'models'),
    directoryCachePath: join(dataRoot, 'directory.json'),
    voicePendingPath: join(dataRoot, 'voice-pending.json'),
    defaultRecordingsDir,
    ensureDir,
    registerRecordingsRoot,
    resolveRecordingsDir,
    listRecordingsRoots,
    resolveMeetingDir,
    validMeetingId,
  };
}
