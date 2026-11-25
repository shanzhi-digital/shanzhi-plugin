import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { writePrivateJsonFile } from './config-store.js';

// EchoMind 凭据存储：
// 优先使用 DSH 宿主凭据服务 ctx.get('credentials')（~/.dsh/.credentials.yaml，0600），
// 无宿主服务时回退到插件同目录的 0600 credentials.json。
// 键名严格遵循 "<scope>/<id>"，两段均为 /^[a-z][a-z0-9-]*$/。

export const CREDENTIAL_SCOPE = 'echomind';
const KEY_SEGMENT_PATTERN = /^[a-z][a-z0-9-]*$/u;

export class CredentialStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CredentialStoreError';
    this.code = code;
  }
}

export function credentialKey(id) {
  if (typeof id !== 'string' || !KEY_SEGMENT_PATTERN.test(id)) {
    throw new TypeError('凭据记录 id 必须是小写字母开头的小写字母、数字或连字符。');
  }
  return `${CREDENTIAL_SCOPE}/${id}`;
}

export function credentialsFilePath(configPath) {
  return join(dirname(configPath), 'credentials.json');
}

const readFailed = () =>
  new CredentialStoreError(
    'CREDENTIAL_READ_FAILED',
    '读取本机凭据失败，请稍后重试；如果一直失败，请检查小智办公的凭据存储。',
  );

const writeFailed = () =>
  new CredentialStoreError(
    'CREDENTIAL_WRITE_FAILED',
    '保存本机凭据失败，请稍后重试；如果一直失败，请检查小智办公的凭据存储。',
  );

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hostCredentialService(ctx) {
  if (!ctx || typeof ctx.get !== 'function') return null;
  let service;
  try {
    service = ctx.get('credentials');
  } catch {
    return null;
  }
  if (
    service &&
    typeof service.readRecord === 'function' &&
    typeof service.modifyRecord === 'function' &&
    typeof service.deleteRecord === 'function'
  ) {
    return service;
  }
  return null;
}

function readFileRecords(filePath) {
  let text;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw readFailed();
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw readFailed();
  }
  if (!isPlainObject(parsed) || (parsed.records !== undefined && !isPlainObject(parsed.records))) {
    throw readFailed();
  }
  return { ...(parsed.records || {}) };
}

function writeFileRecords(filePath, records) {
  try {
    writePrivateJsonFile(filePath, { version: 1, records });
  } catch {
    throw writeFailed();
  }
}

export function createCredentialStore(ctx, { filePath }) {
  return {
    kind() {
      return hostCredentialService(ctx) ? 'dsh-credentials' : 'file';
    },

    async read(id) {
      const key = credentialKey(id);
      const host = hostCredentialService(ctx);
      if (host) {
        try {
          return (await host.readRecord(key)) ?? undefined;
        } catch {
          throw readFailed();
        }
      }
      return readFileRecords(filePath)[key];
    },

    async write(id, record) {
      const key = credentialKey(id);
      const host = hostCredentialService(ctx);
      if (host) {
        try {
          await host.modifyRecord(key, async () => record);
        } catch {
          throw writeFailed();
        }
        return;
      }
      const records = readFileRecords(filePath);
      records[key] = record;
      writeFileRecords(filePath, records);
    },

    async remove(id) {
      const key = credentialKey(id);
      const host = hostCredentialService(ctx);
      if (host) {
        try {
          await host.deleteRecord(key);
        } catch {
          throw writeFailed();
        }
        return;
      }
      const records = readFileRecords(filePath);
      if (!Object.prototype.hasOwnProperty.call(records, key)) return;
      delete records[key];
      writeFileRecords(filePath, records);
    },
  };
}
