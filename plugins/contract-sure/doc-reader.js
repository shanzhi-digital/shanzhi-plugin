import { readFile, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { DEFAULT_CONFIG, resolveOcrApiKey } from './config-store.js';
import { ApiError, defaultApiClient, mimeTypeForFile } from './api-client.js';

export const PLAIN_TEXT_EXTENSIONS = new Set(['.txt', '.md']);
export const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
export const SUPPORTED_EXTENSIONS = new Set(['.pdf', ...IMAGE_EXTENSIONS, ...PLAIN_TEXT_EXTENSIONS]);
export const MAX_READ_BYTES = 50 * 1024 * 1024;
export const OCR_TIMEOUT_MS = 120_000;
export const MIN_TEXT_LAYER_CHARS = 50;

export function normalizeOcrResponse(payload) {
  if (typeof payload === 'string') {
    return { text: payload.trim(), pageCount: null };
  }
  if (!payload || typeof payload !== 'object') {
    return { text: '', pageCount: null };
  }
  const direct = payload.markdown ?? payload.text ?? payload.content;
  if (typeof direct === 'string' && direct.trim()) {
    return {
      text: direct.trim(),
      pageCount: Number.isInteger(payload.pageCount) ? payload.pageCount : Array.isArray(payload.pages) ? payload.pages.length : null,
    };
  }
  const pages = Array.isArray(payload.pages)
    ? payload.pages
    : Array.isArray(payload.data?.pages)
      ? payload.data.pages
      : null;
  if (pages && pages.length > 0) {
    const blocks = pages
      .map((page, index) => {
        const body = typeof page === 'string' ? page : page?.markdown ?? page?.text ?? page?.content ?? '';
        const cleaned = String(body).trim();
        if (!cleaned) return '';
        const pageNo = page?.page ?? page?.pageNumber ?? index + 1;
        return pages.length > 1 ? `--- 第 ${pageNo} 页 ---\n${cleaned}` : cleaned;
      })
      .filter(Boolean);
    if (blocks.length > 0) {
      return { text: blocks.join('\n\n'), pageCount: pages.length };
    }
  }
  if (payload.data && typeof payload.data === 'object') {
    const nested = normalizeOcrResponse(payload.data);
    if (nested.text) return nested;
  }
  const choiceContent = payload.choices?.[0]?.message?.content;
  if (typeof choiceContent === 'string' && choiceContent.trim()) {
    return { text: choiceContent.trim(), pageCount: 1 };
  }
  if (Array.isArray(choiceContent)) {
    const joined = choiceContent
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text.trim())
      .filter(Boolean)
      .join('\n');
    if (joined) return { text: joined, pageCount: 1 };
  }
  return { text: '', pageCount: null };
}

export async function callDeepSeekOcr(filePath, cfg = {}, signal, opts = {}) {
  const { fetchImpl = globalThis.fetch, timeoutMs = OCR_TIMEOUT_MS } = opts;
  const { apiKey } = resolveOcrApiKey(cfg);
  if (!apiKey) {
    throw new ApiError(
      '当前文件为扫描件或图片，需要调用 DeepSeek OCR 接口进行识别，但尚未配置 DeepSeek API Key。请在「设置 → 履约无忧配置」填写 DeepSeek OCR API Key，或调用 contract_config 工具配置 ocrApiKey（也可设置环境变量 DEEPSEEK_API_KEY）。',
      { code: 'OCR_KEY_MISSING' },
    );
  }

  const ocrUrl = (cfg?.ocrApiUrl || DEFAULT_CONFIG.ocrApiUrl).trim();
  const ext = extname(filePath).toLowerCase();
  const bytes = await readFile(filePath);
  const mime = mimeTypeForFile(filePath);

  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort(signal.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error('TIMEOUT'));
  }, timeoutMs);
  timer.unref?.();

  try {
    let response;
    if (/\/chat\/completions\/?$/iu.test(ocrUrl) && IMAGE_EXTENSIONS.has(ext)) {
      const dataUrl = `data:${mime};base64,${bytes.toString('base64')}`;
      response = await fetchImpl(ocrUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          model: cfg?.ocrModel || 'deepseek-vl2',
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: '请完整、准确地识别并提取该图片中的所有文字、表格、合同条款、金额、日期与甲乙方名称，以清晰 Markdown 输出，禁止遗漏或编造。',
                },
                {
                  type: 'image_url',
                  image_url: { url: dataUrl },
                },
              ],
            },
          ],
        }),
        signal: controller.signal,
      });
    } else {
      const form = new FormData();
      form.append('file', new Blob([bytes], { type: mime }), basename(filePath));
      form.append('purpose', 'rich_layout_recognition');
      response = await fetchImpl(ocrUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json',
        },
        body: form,
        signal: controller.signal,
      });
    }

    const contentType = response.headers.get('content-type') || '';
    const rawText = await response.text();
    if (!response.ok) {
      let detail = '';
      try {
        const errJson = JSON.parse(rawText);
        detail = errJson?.error?.message || errJson?.message || '';
      } catch {
        detail = rawText.slice(0, 200);
      }
      throw new ApiError(
        `DeepSeek OCR 接口调用失败（HTTP ${response.status}）${detail ? `：${detail}` : ''}`,
        { status: response.status, code: 'OCR_FAILED' },
      );
    }

    let parsed;
    if (/text\/(?:plain|markdown)/iu.test(contentType)) {
      parsed = normalizeOcrResponse(rawText);
    } else {
      try {
        parsed = normalizeOcrResponse(JSON.parse(rawText));
      } catch {
        parsed = normalizeOcrResponse(rawText);
      }
    }

    if (!parsed.text) {
      throw new ApiError('DeepSeek OCR 未返回有效文本内容，请确认原件清晰度或接口返回格式。', {
        code: 'OCR_EMPTY',
      });
    }
    return parsed;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (timedOut) {
      throw new ApiError('DeepSeek OCR 识别超时，请稍后重试。', { code: 'OCR_TIMEOUT' });
    }
    if (signal?.aborted) {
      throw new ApiError('文档识别已取消。', { code: 'CANCELLED' });
    }
    throw new ApiError(`DeepSeek OCR 请求异常：${error?.message || '网络错误'}`, { code: 'OCR_ERROR' });
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

export async function readDocument(filePath, cfg = {}, opts = {}) {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    throw new ApiError('请提供要读取的文件路径（filePath）。', { code: 'INVALID_ARGUMENT' });
  }
  const cleanPath = filePath.trim();
  const ext = extname(cleanPath).toLowerCase();
  if (ext === '.xlsx' || ext === '.xls') {
    throw new ApiError(
      'Excel 银行流水或发票明细表不需要用文档读取工具解析，请直接调用 contract_manage_flow(action="import_excel") 批量导入。',
      { code: 'USE_IMPORT_EXCEL' },
    );
  }
  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    throw new ApiError(
      `暂不支持该文件格式（${ext || '无扩展名'}）。支持格式：.pdf、.jpg、.jpeg、.png、.webp、.txt、.md。`,
      { code: 'UNSUPPORTED_FORMAT' },
    );
  }

  let info;
  try {
    info = await stat(cleanPath);
  } catch {
    throw new ApiError(`本地文件不存在或无法访问：${cleanPath}`, { code: 'FILE_NOT_FOUND' });
  }
  if (!info.isFile()) {
    throw new ApiError(`路径不是普通文件：${cleanPath}`, { code: 'INVALID_FILE' });
  }
  if (info.size > MAX_READ_BYTES) {
    throw new ApiError('文件大小超过 50MB 上限，无法读取。', { code: 'TOO_LARGE' });
  }

  const fileName = basename(cleanPath);
  const apiClient = opts.apiClient || defaultApiClient;
  const signal = opts.signal;

  if (PLAIN_TEXT_EXTENSIONS.has(ext)) {
    const text = await readFile(cleanPath, 'utf8');
    return {
      filePath: cleanPath,
      fileName,
      ext,
      source: 'plain-text',
      pageCount: 1,
      isScanned: false,
      scannedPageNumbers: [],
      totalChars: text.length,
      text,
    };
  }

  if (ext === '.pdf') {
    const extracted = await apiClient.extractPdfText(cfg, cleanPath, {
      signal,
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    });
    const fullText = typeof extracted?.fullText === 'string' ? extracted.fullText : '';
    const totalChars = Number.isFinite(extracted?.totalChars) ? extracted.totalChars : fullText.trim().length;
    const isScanned = Boolean(extracted?.isScanned) || totalChars < MIN_TEXT_LAYER_CHARS;

    if (!isScanned && totalChars >= MIN_TEXT_LAYER_CHARS) {
      return {
        filePath: cleanPath,
        fileName: extracted.fileName || fileName,
        ext,
        source: 'pdf-text-layer',
        pageCount: extracted.pageCount ?? 1,
        isScanned: false,
        scannedPageNumbers: extracted.scannedPageNumbers || [],
        totalChars,
        text: fullText,
      };
    }

    const ocr = await callDeepSeekOcr(cleanPath, cfg, signal, opts);
    return {
      filePath: cleanPath,
      fileName: extracted?.fileName || fileName,
      ext,
      source: 'deepseek-ocr',
      pageCount: extracted?.pageCount ?? ocr.pageCount ?? null,
      isScanned: true,
      scannedPageNumbers: Array.isArray(extracted?.scannedPageNumbers) ? extracted.scannedPageNumbers : [],
      totalChars: ocr.text.length,
      text: ocr.text,
    };
  }

  // Image files (.jpg, .jpeg, .png, .webp)
  const ocr = await callDeepSeekOcr(cleanPath, cfg, signal, opts);
  return {
    filePath: cleanPath,
    fileName,
    ext,
    source: 'deepseek-ocr',
    pageCount: ocr.pageCount ?? 1,
    isScanned: true,
    scannedPageNumbers: [1],
    totalChars: ocr.text.length,
    text: ocr.text,
  };
}
