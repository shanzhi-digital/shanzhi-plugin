import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { DEFAULT_PROMPT, TOOL_PROTOCOL } from './task-prompts.js';

const invalid = () => { throw Object.assign(new Error('泛化提示词必须是非空字符串，且不超过20000个字符。'), { status: 400, publicMessage: '泛化提示词必须是非空字符串，且不超过20000个字符。' }); };
const validate = input => {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => key !== 'prompt') || typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 20000) invalid();
  return input.prompt;
};
const result = prompt => ({ prompt, defaultPrompt: DEFAULT_PROMPT, protocol: TOOL_PROTOCOL });
const fileError = (error, action) => Object.assign(error, { status: 500, publicMessage: `无法${action}泛化提示词配置：${error.message}` });

export function createSettings({ profileDir } = {}) {
  const profile = resolve(profileDir || process.env.DSH_PROFILE_DIR || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'profiles', process.env.DSH_PROFILE || 'desktop'));
  const directory = join(profile, 'question-set');
  const filename = join(directory, 'settings.json');
  return {
    async get() {
      let contents;
      try { contents = await readFile(filename, 'utf8'); }
      catch (error) { if (error.code === 'ENOENT') return result(DEFAULT_PROMPT); throw fileError(error, '读取'); }
      try { return result(validate(JSON.parse(contents))); }
      catch (error) { throw fileError(error, '读取'); }
    },
    async save(input) {
      const prompt = validate(input);
      const temporary = join(directory, `settings.${randomUUID()}.tmp`);
      try {
        await mkdir(directory, { recursive: true });
        await writeFile(temporary, `${JSON.stringify({ prompt }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
        await rename(temporary, filename);
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => {});
        throw fileError(error, '保存');
      }
      return result(prompt);
    },
  };
}
