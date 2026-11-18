import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { SERVICES } from './constants.js';

export function parseBundledSkill(raw, path = 'SKILL.md') {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw);
  if (!frontmatter) throw new Error(`Bundled skill has no frontmatter: ${path}`);
  const name = /^name:\s*([a-z0-9]+(?:-[a-z0-9]+)*)\s*$/mu.exec(frontmatter[1])?.[1];
  const description = /^description:\s*(.+?)\s*$/mu.exec(frontmatter[1])?.[1];
  if (!name || !description) throw new Error(`Bundled skill metadata is incomplete: ${path}`);
  return { name, description, content: raw.slice(frontmatter[0].length).trim() };
}

/** A read-only bundled provider; the native registry still resolves user-skill precedence. */
export function createBundledSkillProvider({ assetRoot, bundledRank = 600 }) {
  const candidates = SERVICES.map(service => {
    const directory = join(assetRoot, service.name);
    const locator = join(directory, 'SKILL.md');
    const parsed = parseBundledSkill(readFileSync(locator, 'utf8'), locator);
    if (parsed.name !== service.name) throw new Error(`Unexpected bundled skill name: ${parsed.name}`);
    return {
      name: parsed.name,
      description: parsed.description,
      invocation: { modelInvocable: true, userInvocable: true },
      provider: 'datahub-onboarding',
      source: 'bundled',
      rank: bundledRank,
      resourceBase: { kind: 'directory', path: directory.split(sep).join('/') },
      locator,
    };
  });
  return {
    name: 'datahub-onboarding',
    list: async () => candidates,
    async get(candidate, options = {}) {
      const known = candidates.find(item => item.name === candidate?.name && item.locator === candidate?.locator);
      if (!known) return undefined;
      const raw = await readFile(known.locator, { encoding: 'utf8', signal: options.signal });
      const { rank: _rank, locator: _locator, ...summary } = known;
      return { ...summary, content: parseBundledSkill(raw, known.locator).content };
    },
  };
}
