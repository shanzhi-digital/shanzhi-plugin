import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// XLSX_DIR points at the official package unpacked for build/rebuild.mjs.
const here = dirname(fileURLToPath(import.meta.url));
if (!process.env.XLSX_DIR || !process.env.ESBUILD_DIR) {
  throw new Error('Set XLSX_DIR and ESBUILD_DIR to the build dependency directories.');
}
const xlsxDir = resolve(process.env.XLSX_DIR);
const XLSX = await import(pathToFileURL(join(xlsxDir, 'xlsx.mjs')).href);
const esbuild = await import(pathToFileURL(join(resolve(process.env.ESBUILD_DIR), 'lib/main.js')).href);
const bundle = await esbuild.build({
  entryPoints: [join(here, 'export.js')], bundle: true, write: false,
  format: 'esm', platform: 'browser', target: 'es2020',
  alias: { xlsx: join(xlsxDir, 'xlsx.mjs') },
});
const { createExport } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

const value = {
  title: '查询:中文/明细?*',
  columns: [
    { name: 'name', title: '名称,中文' }, { name: 'special', title: '引号"与换行\n列' },
    { name: 'empty' }, { name: 'code', title: '编号' }, { name: 'long', title: '长数字' },
    { name: 'formula', title: '公式文本' }, { name: 'amount', title: '金额' },
    { name: 'numericText', title: '数字字符串' },
  ],
  data: [{
    name: '志愿服务', special: '甲,"乙"\r\n丙', empty: null, code: '00123',
    long: '9223372036854775807', formula: '=HYPERLINK("https://example.com","链接")',
    amount: -12.5, numericText: '123.40',
  }],
};
const headers = ['名称,中文', '引号"与换行\n列', 'empty', '编号', '长数字', '公式文本', '金额', '数字字符串'];

function readXlsx(result) {
  assert.ok(result.data instanceof Uint8Array);
  return XLSX.read(result.data, { type: 'array', cellStyles: true, bookFiles: true });
}
function readCsv(result) {
  assert.equal(typeof result.data, 'string');
  assert.equal(result.data.charCodeAt(0), 0xfeff);
  const workbook = XLSX.read(new TextEncoder().encode(result.data), { type: 'array', raw: true, FS: ',' });
  return XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1, defval: '' });
}

test('XLSX round trip retains all columns, native values and literal formula strings', () => {
  const result = createExport(value, 'xlsx');
  assert.equal(result.filename, '查询_中文_明细__.xlsx');
  assert.equal(result.mime, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  const workbook = readXlsx(result);
  assert.deepEqual(workbook.SheetNames, ['查询结果']);
  const sheet = workbook.Sheets['查询结果'];
  assert.deepEqual(XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' }), [headers, [
    // SheetJS normalizes CRLF when reading; also check the written XML below.
    '志愿服务', '甲,"乙"\n丙', '', '00123', '9223372036854775807',
    '=HYPERLINK("https://example.com","链接")', -12.5, '123.40',
  ]]);
  const sheetXml = new TextDecoder().decode(workbook.files['xl/worksheets/sheet1.xml'].content);
  assert.ok(sheetXml.includes('甲,&quot;乙&quot;_x000d_\n丙'));
  for (const key of ['D2', 'E2', 'F2', 'H2']) assert.equal(sheet[key].t, 's');
  assert.equal(sheet.G2.t, 'n');
  assert.ok(Object.values(sheet).every(cell => !cell?.f));
  assert.equal(sheet['!cols'].length, headers.length);
  assert.ok(sheet['!cols'].every(column => column.width > 0));
});

test('CSV round trip escapes comma, quotes and line breaks with BOM and original string digits', () => {
  const result = createExport(value, 'csv');
  assert.equal(result.filename, '查询_中文_明细__.csv');
  assert.equal(result.mime, 'text/csv;charset=utf-8');
  assert.deepEqual(readCsv(result), [headers, [
    '志愿服务', '甲,"乙"\r\n丙', '', '00123', '9223372036854775807',
    '\'=HYPERLINK("https://example.com","链接")', '-12.5', '123.40',
  ]]);
  assert.ok(result.data.endsWith('\r\n'));
});

test('CSV protects formula and control prefixes while negative numbers remain numeric', () => {
  const strings = ['=1+1', '+SUM(A1)', '-12', '@SUM(A1)', '\t=1+1', '\r=1+1', '\n=1+1', '\u0000=1+1', '\u007f=1+1'];
  const attacks = { title: '安全', columns: [{ name: 'v' }], data: strings.map(v => ({ v })).concat([{ v: -12 }]) };
  const csv = readCsv(createExport(attacks, 'csv'));
  assert.deepEqual(csv.slice(1), strings.map(text => [`'${text}`]).concat([['-12']]));
  const workbook = readXlsx(createExport(attacks, 'xlsx'));
  const sheet = workbook.Sheets['查询结果'];
  assert.deepEqual(XLSX.utils.sheet_to_json(sheet, { header: 1 }), [['v'], ...strings.map(text => [text]), [-12]]);
  assert.ok(Object.values(sheet).every(cell => !cell?.f));
});

test('paged exports contain loaded rows only and report offset/total in a separate explanation', () => {
  const paged = { ...value, offset: 20, rowCount: 99, truncated: true };
  const result = createExport(paged, 'csv');
  const lines = readCsv(result);
  assert.deepEqual(lines[2], Array(headers.length).fill(''));
  assert.match(lines[3][0], /仅导出当前已加载的 1 行/);
  assert.match(lines[3][0], /第 21–21 行；offset=20；total=99/);
  const workbook = readXlsx(createExport(paged, 'xlsx'));
  assert.deepEqual(workbook.SheetNames, ['查询结果', '导出说明']);
  assert.equal(XLSX.utils.sheet_to_json(workbook.Sheets['查询结果']).length, 1);
  assert.equal(workbook.Sheets['导出说明'].A2.v, lines[3][0]);
});

test('offset or a larger total still explains partial exports, including an empty page', () => {
  for (const partial of [{ offset: 3 }, { total: 10 }, { truncated: true }]) {
    const workbook = readXlsx(createExport({ ...value, ...partial }, 'xlsx'));
    assert.ok(workbook.SheetNames.includes('导出说明'));
  }
  const empty = { title: '空结果', columns: [{ name: 'a', title: '甲' }], data: [], offset: 100, rowCount: 100 };
  const workbook = readXlsx(createExport(empty, 'xlsx'));
  assert.deepEqual(XLSX.utils.sheet_to_json(workbook.Sheets['查询结果'], { header: 1 }), [['甲']]);
  assert.match(workbook.Sheets['导出说明'].A2.v, /0 行（空结果；offset=100；total=100）/);
});

test('filenames remove Windows forbidden characters, trailing dots and reserved device names', () => {
  for (const [title, expected] of [['CON', '_CON.csv'], ['a<>:"/\\|?*\u0000. ', 'a__________.csv'], ['...', '查询结果.csv'], ['', '查询结果.csv']]) {
    assert.equal(createExport({ ...value, title }, 'csv').filename, expected);
  }
  assert.throws(() => createExport(value, 'pdf'), /不支持的导出格式/);
});
