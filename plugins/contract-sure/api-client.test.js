import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, truncateSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_LOCAL_FILE_BYTES,
  extractPdfText,
  normalizeServerUrl,
  readFileBounded,
  readLocalFile,
  requestJson,
  safeErrorMessage,
} from './api-client.js';

const workDir = mkdtempSync(join(tmpdir(), 'contract-sure-api-client-'));
test.after(() => rmSync(workDir, { recursive: true, force: true }));

const CFG = { serverUrl: 'http://lvyue.test/api/v1', apiToken: 'plugin-jwt-secret-1' };
const respond = (status, body, contentType = 'application/json') => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': contentType } });
  };
  return { fetchImpl, calls };
};

test('requestJson never follows redirects', async () => {
  const { fetchImpl, calls } = respond(200, { code: 200, data: { ok: true } });
  assert.deepEqual(await requestJson(CFG, '/auth/me', { fetchImpl }), { ok: true });
  assert.equal(calls[0].init.redirect, 'error');

  // fetch 因重定向被拒时抛 TypeError：转成固定文案。
  const redirected = async () => {
    throw new TypeError('fetch failed', { cause: new Error('unexpected redirect to http://evil.example/steal?secret=1') });
  };
  await assert.rejects(
    () => requestJson(CFG, '/auth/me', { fetchImpl: redirected }),
    (error) => error.code === 'NETWORK_ERROR' && !/evil|secret|fetch failed/u.test(error.message),
  );
});

test('HTTP 401/403 are decided before the envelope; envelope 401/403 count only when HTTP succeeded', async () => {
  const cases = [
    [401, { code: 401, message: 'expired' }, 'UNAUTHORIZED'],
    [403, { code: 403, message: '无操作权限' }, 'FORBIDDEN'],
    // HTTP 403 但信封写 401：按 HTTP 403。
    [403, { code: 401, message: 'token invalid' }, 'FORBIDDEN'],
    // HTTP 401 但信封写 200：按 HTTP 401。
    [401, { code: 200, data: {} }, 'UNAUTHORIZED'],
    [200, { code: 401, message: '登录已过期' }, 'UNAUTHORIZED'],
    [200, { code: 403, message: '无操作权限' }, 'FORBIDDEN'],
  ];
  for (const [status, body, code] of cases) {
    const { fetchImpl } = respond(status, body);
    await assert.rejects(
      () => requestJson(CFG, '/contracts', { fetchImpl }),
      (error) => error.code === code && error.status === status,
      `HTTP ${status} + ${JSON.stringify(body)}`,
    );
  }
});

test('business and HTTP errors use fixed messages and string codes, never the backend text', async () => {
  const echo = 'Authorization: Bearer plugin-jwt-secret-1 pollSecret=abc';
  const cases = [
    [200, { code: 409, message: `合同编号 HT-X-999 已存在 ${echo}` }, 'CONFLICT', 409],
    [200, { code: 404, message: `授权请求不存在 ${echo}` }, 'NOT_FOUND', 404],
    [200, { code: 400, message: echo }, 'BAD_REQUEST', 400],
    [200, { code: 410, message: echo }, 'GONE', 410],
    [200, { code: 429, message: echo }, 'RATE_LIMITED', 429],
    [200, { code: 500, message: `NullPointerException ${echo}` }, 'SERVER_ERROR', 500],
    [200, { code: 418, message: echo }, 'BUSINESS_ERROR', 418],
    [200, { code: 'weird', message: echo }, 'BUSINESS_ERROR', undefined],
    [500, `<html>${echo}</html>`, 'SERVER_ERROR', undefined],
    [503, { code: 503, message: echo }, 'SERVER_ERROR', undefined],
    [404, { status: 404, path: echo }, 'HTTP_ERROR', undefined],
    [429, { message: echo }, 'RATE_LIMITED', undefined],
  ];
  for (const [status, body, code, businessCode] of cases) {
    const { fetchImpl } = respond(status, body, typeof body === 'string' ? 'text/html' : 'application/json');
    await assert.rejects(
      () => requestJson(CFG, '/contracts', { fetchImpl }),
      (error) =>
        error.code === code &&
        error.businessCode === businessCode &&
        !/plugin-jwt|pollSecret|NullPointer|HT-X-999|<html>/u.test(error.message),
      `${status} ${JSON.stringify(body)}`,
    );
  }
  const { fetchImpl } = respond(200, 'not json at all secret', 'text/plain');
  await assert.rejects(() => requestJson(CFG, '/contracts', { fetchImpl }), (error) => error.code === 'INVALID_JSON' && !/secret/u.test(error.message));

  // 底层异常里带出的请求头不回显；非 ApiError 的异常对外只给兜底文案。
  const thrower = async () => {
    throw new TypeError('Invalid header value: "Bearer plugin-jwt-secret-1"');
  };
  await assert.rejects(
    () => requestJson(CFG, '/contracts', { fetchImpl: thrower }),
    (error) => error.code === 'NETWORK_ERROR' && !/plugin-jwt|Invalid header/u.test(error.message),
  );
  assert.equal(safeErrorMessage(new Error('raw secret text')), '未知错误');
});

test('server URLs with a username or password are rejected without echoing the URL', () => {
  for (const url of ['http://admin:hunter2@lvyue.test/api/v1', 'https://admin@lvyue.test/api/v1', 'http://:hunter2@lvyue.test']) {
    assert.throws(() => normalizeServerUrl(url), (error) => error.code === 'INVALID_URL' && !/hunter2|admin/u.test(error.message));
  }
  assert.throws(() => normalizeServerUrl('not a url hunter2'), (error) => error.code === 'INVALID_URL' && !/hunter2/u.test(error.message));
  assert.equal(normalizeServerUrl(' https://lvyue.test/api/v1/ '), 'https://lvyue.test/api/v1');
});

test('local file reads are capped by the bytes actually read: limit + 1 bytes means rejection', async () => {
  const exact = join(workDir, 'exact.pdf');
  writeFileSync(exact, Buffer.alloc(10, 0x41));
  assert.equal((await readFileBounded(exact, 10)).byteLength, 10);
  const over = join(workDir, 'over.pdf');
  writeFileSync(over, Buffer.alloc(11, 0x41));
  await assert.rejects(() => readFileBounded(over, 10), (error) => error.code === 'TOO_LARGE');

  // 默认上限 20MB：恰好 20MB 可读，多 1 字节就拒绝。
  const big = join(workDir, 'big.pdf');
  writeFileSync(big, '%PDF-1.4\n');
  truncateSync(big, MAX_LOCAL_FILE_BYTES);
  assert.equal((await readFileBounded(big)).byteLength, MAX_LOCAL_FILE_BYTES);
  truncateSync(big, MAX_LOCAL_FILE_BYTES + 1);
  await assert.rejects(() => readFileBounded(big), (error) => error.code === 'TOO_LARGE');
  await assert.rejects(() => readLocalFile(big), (error) => error.code === 'TOO_LARGE');
});

test('readLocalFile rejects links whose target type differs from the given extension', async () => {
  const xlsx = join(workDir, 'report.xlsx');
  writeFileSync(xlsx, Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  const disguised = join(workDir, 'report-link.pdf');
  symlinkSync(xlsx, disguised);
  await assert.rejects(() => readLocalFile(disguised), (error) => error.code === 'UNSUPPORTED_FORMAT');

  const jpeg = join(workDir, 'photo.jpeg');
  writeFileSync(jpeg, Buffer.from([0xff, 0xd8, 0xff]));
  const jpgLink = join(workDir, 'photo-link.jpg');
  symlinkSync(jpeg, jpgLink);
  assert.equal((await readLocalFile(jpgLink)).bytes.byteLength, 3);
});

test('uploads reuse the bytes that were already read instead of opening the path again', async () => {
  const pdf = join(workDir, 'once.pdf');
  writeFileSync(pdf, Buffer.from('%PDF-1.4\n% checked bytes'));
  const file = await readLocalFile(pdf);
  rmSync(pdf);
  let sent = null;
  const fetchImpl = async (_url, init) => {
    sent = Buffer.from(await init.body.get('file').arrayBuffer());
    assert.equal(init.redirect, 'error');
    return new Response(JSON.stringify({ code: 200, data: { fullText: 'x' } }), { status: 200 });
  };
  await extractPdfText(CFG, file, { fetchImpl });
  assert.equal(sent.toString('utf8'), '%PDF-1.4\n% checked bytes');
});
