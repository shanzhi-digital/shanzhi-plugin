import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ApiError } from './api-client.js';
import { writePrivateJsonFile } from './config-store.js';

// 插件令牌的存放处。
// 优先用 DSH 宿主的凭据服务 ctx.get('credentials')（@deepseek-ai/dsh-credentials，落盘 ~/.dsh/.credentials.yaml，0600）；
// 宿主没有挂载该服务时，退回插件自己的 0600 文件（与配置文件同目录的 credentials.json）。
// 两种模式互不混用：宿主模式只读写宿主凭据服务，不再拿本地文件兜底。
//
// 记录地址是 "<scope>/<id>"。宿主 credentialKey() 在运行时就是把两段用 "/" 拼起来，
// 两段都必须匹配 /^[a-z][a-z0-9-]*$/，scope 写插件自己的注册名 salesforge（宿主的 llm-pi-ai 插件用 'llm-pi-ai'）。
// 这里按同一规则自行拼接，不依赖宿主包。
//
// 读取区分「没有这条记录」（返回 undefined）和「读取失败」（抛 CREDENTIAL_READ_FAILED）：
// 读取失败不能当成空，否则会丢掉吊销旧令牌所需的记录，或者用空库覆盖其他记录。

export const CREDENTIAL_SCOPE = 'salesforge';
const KEY_SEGMENT_PATTERN = /^[a-z][a-z0-9-]*$/u;

export function credentialKey(id) {
  if (!KEY_SEGMENT_PATTERN.test(id)) {
    throw new TypeError('凭据记录 id 必须是小写字母开头的小写字母、数字或连字符。');
  }
  return `${CREDENTIAL_SCOPE}/${id}`;
}

export function credentialsFilePath(configPath) {
  return join(dirname(configPath), 'credentials.json');
}

const readFailed = () =>
  new ApiError('读取本机凭据失败，请稍后重试；如果一直失败，请检查小智办公的凭据存储。', {
    code: 'CREDENTIAL_READ_FAILED',
  });
const writeFailed = () =>
  new ApiError('保存本机凭据失败，请稍后重试；如果一直失败，请检查小智办公的凭据存储。', {
    code: 'CREDENTIAL_WRITE_FAILED',
  });

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

// 只有文件不存在（ENOENT）才是空库；读不了、解析失败、结构不对都抛错，调用方据此停止写入。
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

/**
 * 创建凭据存储。每次操作都重新取一次宿主服务。
 * 记录形如 { kind: 'grant', payload }，与宿主 CredentialRecord 一致。
 */
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
