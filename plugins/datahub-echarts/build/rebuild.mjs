// Rebuild ../client.js from client-entry.js.
// Usage (from the package root):
//   node build/rebuild.mjs <esbuildDir> <echartsDir>
// e.g. node build/rebuild.mjs <repo>/.worktrees/<fe-tree>/node_modules/esbuild <repo>/.worktrees/<fe-tree>/node_modules/echarts
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const [esbuildDir, echartsDir] = process.argv.slice(2);
if (!esbuildDir || !echartsDir) {
  console.error('usage: node build/rebuild.mjs <esbuildDir> <echartsDir>');
  process.exit(2);
}

const esbuild = await import(pathToFileURL(join(esbuildDir, 'lib', 'main.js')).href);
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const result = await esbuild.build({
  entryPoints: [join(root, 'build', 'client-entry.js')],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'browser',
  target: 'es2020',
  legalComments: 'none',
  define: { __PLUGIN_VERSION__: JSON.stringify(version) },
  external: ['react'],
  alias: { echarts: echartsDir },
  logLevel: 'warning',
});

const code = result.outputFiles[0].text;
const wrapped = `window.__ModuleLoader__.load({id:'@local/datahub-echarts', factory(require){ const module={exports:{}};const exports=module.exports;\n${code}\nreturn module.exports; }});\n`;
writeFileSync(join(root, 'client.js'), wrapped);
console.log(`client.js written (${wrapped.length} chars)`);
