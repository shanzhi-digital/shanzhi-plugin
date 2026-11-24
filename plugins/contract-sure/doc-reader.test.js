import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, truncateSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readDocument, callDeepSeekOcr, normalizeOcrResponse } from './doc-reader.js';

const workDir = mkdtempSync(join(tmpdir(), 'contract-sure-doc-reader-'));
test.after(() => rmSync(workDir, { recursive: true, force: true }));

test('plain text (.txt and .md) reads UTF-8 directly without network calls', async () => {
  const txtPath = join(workDir, 'contract.txt');
  const mdPath = join(workDir, 'terms.md');
  writeFileSync(txtPath, '甲方：甲公司\n乙方：乙公司\n总金额：100000元', 'utf8');
  writeFileSync(mdPath, '# 补充协议\n金额：50000元', 'utf8');

  let fetchCalled = false;
  const fetchImpl = async () => {
    fetchCalled = true;
    throw new Error('should not call fetch');
  };

  const resTxt = await readDocument(txtPath, {}, { fetchImpl });
  assert.equal(resTxt.source, 'plain-text');
  assert.equal(resTxt.isScanned, false);
  assert.match(resTxt.text, /100000元/);

  const resMd = await readDocument(mdPath, {}, { fetchImpl });
  assert.equal(resMd.source, 'plain-text');
  assert.match(resMd.text, /补充协议/);
  assert.equal(fetchCalled, false);
});

test('electronic PDF (!isScanned && totalChars >= 50) uses backend text layer and skips DeepSeek OCR', async () => {
  const pdfPath = join(workDir, 'HT-2026-001.pdf');
  writeFileSync(pdfPath, Buffer.from('%PDF-1.4\n% mock electronic pdf'));

  const longText = '--- 第 1 页 ---\n销售合同编号：HT-2026-001，甲方：善治科技有限公司，乙方：数智服务有限公司，合同总额人民币 500,000.00 元整。';
  let ocrCalled = false;
  const mockApiClient = {
    async extractPdfText(_cfg, file) {
      // 传进来的是已经读好的文件对象，不再按路径重读。
      assert.equal(file.fileName, 'HT-2026-001.pdf');
      assert.ok(Buffer.isBuffer(file.bytes));
      assert.equal(file.bytes.toString('utf8'), '%PDF-1.4\n% mock electronic pdf');
      return {
        fileName: 'HT-2026-001.pdf',
        pageCount: 2,
        totalChars: longText.length,
        isScanned: false,
        scannedPageNumbers: [],
        pages: [{ page: 1, charCount: longText.length, text: longText }],
        fullText: longText,
      };
    },
  };
  const fetchImpl = async () => {
    ocrCalled = true;
    throw new Error('OCR should not be invoked for electronic PDF');
  };

  const result = await readDocument(
    pdfPath,
    { serverUrl: 'http://localhost:8081/api/v1', apiToken: 'tok', ocrApiKey: 'sk-test' },
    { apiClient: mockApiClient, fetchImpl },
  );

  assert.equal(result.source, 'pdf-text-layer');
  assert.equal(result.isScanned, false);
  assert.equal(result.pageCount, 2);
  assert.equal(result.text, longText);
  assert.equal(ocrCalled, false);
});

test('scanned PDF (isScanned: true) falls back to DeepSeek OCR API with multipart purpose=rich_layout_recognition', async () => {
  const pdfPath = join(workDir, 'scanned-contract.pdf');
  const original = Buffer.from('%PDF-1.4\n% scanned pdf bytes');
  writeFileSync(pdfPath, original);

  const mockApiClient = {
    async extractPdfText() {
      // 抽字期间文件被换掉：OCR 仍然用最初读入、检查过的那份字节。
      writeFileSync(pdfPath, Buffer.from('%PDF-1.4\n% swapped after extraction, should never be sent'));
      return {
        fileName: 'scanned-contract.pdf',
        pageCount: 2,
        totalChars: 6,
        isScanned: true,
        scannedPageNumbers: [1, 2],
        pages: [],
        fullText: '',
      };
    },
  };

  let capturedUrl = null;
  let capturedAuth = null;
  let capturedPurpose = null;
  let capturedFilename = null;
  let capturedBytes = null;
  let capturedRedirect = null;

  const fetchImpl = async (url, init) => {
    capturedUrl = url;
    capturedAuth = init.headers.Authorization;
    capturedRedirect = init.redirect;
    assert.ok(init.body instanceof FormData);
    capturedPurpose = init.body.get('purpose');
    capturedFilename = init.body.get('file')?.name;
    capturedBytes = Buffer.from(await init.body.get('file').arrayBuffer());
    return new Response(
      JSON.stringify({
        pages: [
          { page: 1, markdown: '# 采购合同\n合同编号：CG-2026-009' },
          { page: 2, markdown: '合同总价：200000 元，验收通过后15个工作日付款。' },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };

  const result = await readDocument(
    pdfPath,
    {
      serverUrl: 'http://localhost:8081/api/v1',
      apiToken: 'tok',
      ocrApiUrl: 'https://api.deepseek.com/v1/tools/ocr',
      ocrApiKey: 'sk-deepseek-1234',
    },
    { apiClient: mockApiClient, fetchImpl },
  );

  assert.equal(result.source, 'deepseek-ocr');
  assert.equal(result.isScanned, true);
  assert.equal(result.pageCount, 2);
  assert.deepEqual(result.scannedPageNumbers, [1, 2]);
  assert.equal(capturedUrl, 'https://api.deepseek.com/v1/tools/ocr');
  assert.equal(capturedAuth, 'Bearer sk-deepseek-1234');
  assert.equal(capturedPurpose, 'rich_layout_recognition');
  assert.equal(capturedFilename, 'scanned-contract.pdf');
  assert.deepEqual(capturedBytes, original);
  // 第 3 条：OCR 请求不跟随重定向。
  assert.equal(capturedRedirect, 'error');
  assert.match(result.text, /--- 第 1 页 ---/);
  assert.match(result.text, /CG-2026-009/);
  assert.match(result.text, /--- 第 2 页 ---/);
});

test('image files invoke DeepSeek OCR directly and support OpenAI-compatible /chat/completions fallback', async () => {
  const pngPath = join(workDir, 'invoice.png');
  writeFileSync(pngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

  // 1. Standard DeepSeek OCR endpoint
  const resStandard = await readDocument(
    pngPath,
    { ocrApiUrl: 'https://api.deepseek.com/v1/tools/ocr', ocrApiKey: 'sk-img' },
    {
      fetchImpl: async () =>
        new Response(JSON.stringify({ data: { text: '增值税专用发票 价税合计：¥100,000.00' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    },
  );
  assert.equal(resStandard.source, 'deepseek-ocr');
  assert.match(resStandard.text, /100,000\.00/);

  // 2. OpenAI-compatible /chat/completions vision fallback
  let capturedBody = null;
  const resVision = await readDocument(
    pngPath,
    { ocrApiUrl: 'https://example.com/v1/chat/completions', ocrApiKey: 'sk-vision' },
    {
      fetchImpl: async (_url, init) => {
        assert.equal(init.redirect, 'error');
        capturedBody = JSON.parse(init.body);
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: '银行回单 付款金额：50000元 日期：2026-06-01' } }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    },
  );
  assert.equal(resVision.source, 'deepseek-ocr');
  assert.match(resVision.text, /50000元/);
  assert.equal(capturedBody.messages[0].content[1].type, 'image_url');
  assert.match(capturedBody.messages[0].content[1].image_url.url, /^data:image\/png;base64,/);
});

test('missing OCR API key (neither config nor DEEPSEEK_API_KEY env) produces actionable Chinese guidance', async () => {
  const jpgPath = join(workDir, 'receipt.jpg');
  writeFileSync(jpgPath, Buffer.from([0xff, 0xd8, 0xff, 0xe0]));

  const prevEnv = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  try {
    await assert.rejects(
      () => readDocument(jpgPath, { ocrApiKey: '' }),
      (err) => {
        assert.equal(err.code, 'OCR_KEY_MISSING');
        assert.match(err.message, /设置 → 履约无忧配置/);
        assert.doesNotMatch(err.message, /contract_config/);
        assert.match(err.message, /DEEPSEEK_API_KEY/);
        return true;
      },
    );

    // Env var fallback works when set
    process.env.DEEPSEEK_API_KEY = 'sk-from-env';
    const res = await callDeepSeekOcr(jpgPath, { ocrApiKey: '' }, undefined, {
      fetchImpl: async (_url, init) => {
        assert.equal(init.headers.Authorization, 'Bearer sk-from-env');
        return new Response(JSON.stringify({ markdown: '收款回单识别结果' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    assert.equal(res.text, '收款回单识别结果');

    // 环境变量只发给官方 api.deepseek.com，自定义 OCR 地址不用。
    let customCalled = false;
    await assert.rejects(
      () =>
        callDeepSeekOcr(jpgPath, { ocrApiUrl: 'https://ocr.example.com/v1/ocr', ocrApiKey: '' }, undefined, {
          fetchImpl: async () => {
            customCalled = true;
            throw new Error('should not call fetch');
          },
        }),
      (err) => err.code === 'OCR_KEY_MISSING',
    );
    assert.equal(customCalled, false);
  } finally {
    if (prevEnv !== undefined) process.env.DEEPSEEK_API_KEY = prevEnv;
    else delete process.env.DEEPSEEK_API_KEY;
  }
});

test('Excel files redirect user to contract_manage_flow(action="import_excel") and normalizeOcrResponse handles variants', async () => {
  const xlsxPath = join(workDir, 'bank.xlsx');
  writeFileSync(xlsxPath, Buffer.from('PK\x03\x04mock'));

  await assert.rejects(
    () => readDocument(xlsxPath, {}),
    (err) => {
      assert.equal(err.code, 'USE_IMPORT_EXCEL');
      assert.match(err.message, /import_excel/);
      return true;
    },
  );

  assert.equal(normalizeOcrResponse({ markdown: '  hello  ' }).text, 'hello');
  assert.equal(normalizeOcrResponse({ text: 'world' }).text, 'world');
  assert.equal(normalizeOcrResponse({ data: { text: 'nested' } }).text, 'nested');
  assert.equal(normalizeOcrResponse({ choices: [{ message: { content: 'vision' } }] }).text, 'vision');
});

test('readDocument rejects formats outside the whitelist, directories and files over 20MB before any network call', async () => {
  let fetchCalled = false;
  const fetchImpl = async () => {
    fetchCalled = true;
    throw new Error('should not call fetch');
  };
  const webpPath = join(workDir, 'photo.webp');
  writeFileSync(webpPath, Buffer.from('RIFF0000WEBP'));
  await assert.rejects(() => readDocument(webpPath, { ocrApiKey: 'sk-x' }, { fetchImpl }), (err) => err.code === 'UNSUPPORTED_FORMAT');

  const jsonPath = join(workDir, 'dsh-config.json');
  writeFileSync(jsonPath, '{"apiToken":"secret"}');
  await assert.rejects(() => readDocument(jsonPath, {}, { fetchImpl }), (err) => err.code === 'UNSUPPORTED_FORMAT');

  const dirPath = join(workDir, 'scans.png');
  mkdirSync(dirPath);
  await assert.rejects(() => readDocument(dirPath, { ocrApiKey: 'sk-x' }, { fetchImpl }), (err) => err.code === 'INVALID_FILE');

  const bigPath = join(workDir, 'huge.png');
  writeFileSync(bigPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  truncateSync(bigPath, 20 * 1024 * 1024 + 1);
  await assert.rejects(() => readDocument(bigPath, { ocrApiKey: 'sk-x' }, { fetchImpl }), (err) => err.code === 'TOO_LARGE');

  assert.equal(fetchCalled, false);
});

test('OCR errors use fixed messages: no response body, no low-level exception text, no key with control characters', async () => {
  const pngPath = join(workDir, 'receipt-errors.png');
  writeFileSync(pngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const cfg = { ocrApiUrl: 'https://api.deepseek.com/v1/tools/ocr', ocrApiKey: 'sk-secret-ocr-key-123' };

  // 服务端把请求头回显在错误正文里。
  await assert.rejects(
    () =>
      callDeepSeekOcr(pngPath, cfg, undefined, {
        fetchImpl: async () =>
          new Response(JSON.stringify({ error: { message: 'bad Authorization: Bearer sk-secret-ocr-key-123' } }), {
            status: 400,
            headers: { 'content-type': 'application/json' },
          }),
      }),
    (err) => err.code === 'OCR_FAILED' && /HTTP 400/u.test(err.message) && !/sk-secret|Authorization/u.test(err.message),
  );
  await assert.rejects(
    () =>
      callDeepSeekOcr(pngPath, cfg, undefined, {
        fetchImpl: async () => new Response('invalid key sk-secret-ocr-key-123', { status: 401 }),
      }),
    (err) => err.code === 'OCR_UNAUTHORIZED' && !/sk-secret/u.test(err.message),
  );
  // 底层异常（例如无效请求头时 Node 带出的 header 值、重定向被拒）不回显。
  await assert.rejects(
    () =>
      callDeepSeekOcr(pngPath, cfg, undefined, {
        fetchImpl: async () => {
          throw new TypeError('Invalid header value: "Bearer sk-secret-ocr-key-123"');
        },
      }),
    (err) => err.code === 'OCR_ERROR' && !/sk-secret|Invalid header/u.test(err.message),
  );
  // Key 里有换行：直接拒绝，不发请求。
  let called = false;
  await assert.rejects(
    () =>
      callDeepSeekOcr(pngPath, { ...cfg, ocrApiKey: 'sk-secret\nInjected: 1' }, undefined, {
        fetchImpl: async () => {
          called = true;
          return new Response('{}');
        },
      }),
    (err) => err.code === 'OCR_KEY_INVALID' && !/sk-secret|Injected/u.test(err.message),
  );
  assert.equal(called, false);
});

test('a link whose target type differs from its extension is rejected (an image name pointing at a text file is not sent to OCR)', async () => {
  const notesPath = join(workDir, 'private-notes.txt');
  writeFileSync(notesPath, 'secret notes');
  const disguised = join(workDir, 'disguised-scan.png');
  symlinkSync(notesPath, disguised);
  let called = false;
  await assert.rejects(
    () =>
      readDocument(disguised, { ocrApiKey: 'sk-x' }, {
        fetchImpl: async () => {
          called = true;
          return new Response('{}');
        },
      }),
    (err) => err.code === 'UNSUPPORTED_FORMAT',
  );
  assert.equal(called, false);
});
