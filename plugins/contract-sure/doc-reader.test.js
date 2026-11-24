import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
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
    async extractPdfText(_cfg, filePath) {
      assert.equal(filePath, pdfPath);
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
  writeFileSync(pdfPath, Buffer.from('%PDF-1.4\n% scanned pdf bytes'));

  const mockApiClient = {
    async extractPdfText() {
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

  const fetchImpl = async (url, init) => {
    capturedUrl = url;
    capturedAuth = init.headers.Authorization;
    assert.ok(init.body instanceof FormData);
    capturedPurpose = init.body.get('purpose');
    capturedFilename = init.body.get('file')?.name;
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
        assert.match(err.message, /contract_config/);
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
