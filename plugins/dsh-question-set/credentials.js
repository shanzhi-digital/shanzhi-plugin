import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { openManagementDb } from './management-db.js';

const fail = message => { throw Object.assign(new Error(message), { publicMessage: message, status: 400 }); };

/** Read the existing SQL plugin credential records without creating or changing them. */
export async function readSourcePassword(credentials, source) {
  if (source.engine === 'sqlite') return undefined;
  const id = `dsh-datasource:${source.credentialRef ?? source.id}:password`.replaceAll(':', '-').toLowerCase();
  if (!/^[a-z][a-z0-9-]*$/.test(id)) fail('无效的连接凭据标识。');
  try {
    const record = await credentials.readRecord(`sql/${id}`);
    return record?.kind === 'grant' && typeof record.payload?.password === 'string' ? record.payload.password : undefined;
  } catch { fail('无法读取数据库凭据。'); }
}

export async function openSharedDb(ctx) {
  const profileDir = resolve(process.env.DSH_PROFILE_DIR || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'profiles', process.env.DSH_PROFILE || 'desktop'));
  const profileId = createHash('sha256').update(process.platform === 'win32' ? profileDir.toLowerCase() : profileDir).digest('hex');
  const record = await ctx.credentials.readRecord(`sql/management-${profileId}`);
  if (record?.kind !== 'grant' || !record.payload || typeof record.payload !== 'object') fail('请先在数据源页面配置 MySQL 管理库。');
  const input = record.payload, config = {};
  for (const key of ['host', 'user', 'database']) {
    const value = input[key];
    if (typeof value !== 'string' || !value.trim() || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) fail('管理库配置格式无效。');
    config[key] = value.trim();
  }
  if (/[\s/@\\?#]/.test(config.host) || config.host.includes('://')) fail('管理库主机地址格式无效。');
  const port = input.port ?? 3306;
  config.port = typeof port === 'string' && /^\d+$/.test(port) ? Number(port) : port;
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535 || (input.password !== undefined && typeof input.password !== 'string')) fail('管理库配置格式无效。');
  config.password = input.password || '';
  const db = await openManagementDb({ ...config, profileId });
  // Keep the password exclusively in the driver's pool; query policy only needs identity.
  db.managementConfig = { host: config.host, port: config.port, database: config.database, engine: 'mysql' };
  return db;
}
