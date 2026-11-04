import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

// Explicit projection is also the last boundary before serializing metadata.
// Credentials and UI-only fields never enter this file.
const FIELDS = ['id', 'name', 'description', 'engine', 'host', 'port', 'user', 'database', 'file'];
function metadataOnly(record) {
  return Object.fromEntries(FIELDS.filter((key) => record[key] !== undefined).map((key) => [key, record[key]]));
}

export class DatasourceStore {
  #filePath;
  #records = [];
  #initialized = false;

  constructor(filePath) {
    if (typeof filePath !== 'string' || !filePath.trim()) throw new Error('需要指定数据源配置文件路径。');
    this.#filePath = resolve(filePath);
  }

  async initialize() {
    if (this.#initialized) return;
    let text;
    try {
      text = await readFile(this.#filePath, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw new Error('无法读取数据源配置文件。');
      this.#initialized = true;
      return;
    }
    try {
      const parsed = JSON.parse(text);
      if (parsed?.version !== 1 || !Array.isArray(parsed.connections)) throw new Error();
      if (parsed.connections.some((item) => !item || typeof item !== 'object' || Array.isArray(item) || 'password' in item)) throw new Error();
      this.#records = parsed.connections.map(metadataOnly);
      this.#initialized = true;
    } catch {
      throw new Error('数据源配置文件格式无效，请检查配置文件；原文件未修改。');
    }
  }

  list() {
    return this.#records.map((record) => ({ ...record }));
  }

  async replace(records) {
    if (!this.#initialized) throw new Error('数据源存储尚未初始化。');
    const next = records.map(metadataOnly);
    const directory = dirname(this.#filePath);
    const temporary = this.#filePath + '.' + randomUUID() + '.tmp';
    let handle;
    try {
      await mkdir(directory, { recursive: true });
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ version: 1, connections: next }, null, 2) + '\n', 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      // Same-directory rename is atomic; publish memory only after the disk commit.
      await rename(temporary, this.#filePath);
      this.#records = next;
    } catch {
      throw new Error('无法保存数据源配置文件，原配置保持不变。');
    } finally {
      if (handle) await handle.close().catch(() => {});
      await unlink(temporary).catch(() => {});
    }
  }
}
