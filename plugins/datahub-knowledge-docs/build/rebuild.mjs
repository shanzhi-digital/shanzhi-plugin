// node build/rebuild.mjs <esbuild package directory>
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const esbuildDir = process.argv[2];
if (!esbuildDir) throw new Error('Usage: node build/rebuild.mjs <esbuild package directory>');
const esbuild = await import(pathToFileURL(join(resolve(esbuildDir), 'lib/main.js')).href);
const { name } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const result = await esbuild.build({
  entryPoints: [join(here, 'client-entry.js')], bundle: true, write: false,
  format: 'cjs', platform: 'browser', target: 'es2020', external: ['react'],
  legalComments: 'none', logLevel: 'warning'
});
const code = `window.__ModuleLoader__.load({id:${JSON.stringify(name)},factory(require){const module={exports:{}};const exports=module.exports;\n${result.outputFiles[0].text}\nreturn module.exports;}});\n`;
writeFileSync(join(root, 'client.js'), code);
console.log(`Built ${name}: ${Buffer.byteLength(code)} bytes`);
