import { basename, extname } from 'node:path';
import { DEFAULT_CONFIG, isHeaderSafeSecret, resolveOcrApiKey } from './config-store.js';
import { ApiError, MAX_LOCAL_FILE_BYTES, defaultApiClient, mimeTypeForFile, readLocalFile } from './api-client.js';

export const PLAIN_TEXT_EXTENSIONS = new Set(['.txt', '.md']);
export const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png']);
export const SUPPORTED_EXTENSIONS = new Set(['.pdf', ...IMAGE_EXTENSIONS, ...PLAIN_TEXT_EXTENSIONS]);
export const MAX_READ_BYTES = MAX_LOCAL_FILE_BYTES;
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

const OCR_EXTENSIONS = Object.freeze(['.pdf', ...IMAGE_EXTENSIONS]);

/**
 * 调 DeepSeek OCR。source 可以是本地路径，也可以是 readLocalFile 已读好的文件对象（复用同一份字节）。
 * Key 只用 cfg.ocrApiKey（已按 OCR 地址的 origin 核对过）；没有时只有官方 api.deepseek.com 才用环境变量。
 */
export async function callDeepSeekOcr(source, cfg = {}, signal, opts = {}) {
  const { fetchImpl = globalThis.fetch, timeoutMs = OCR_TIMEOUT_MS } = opts;
  const { apiKey } = resolveOcrApiKey(cfg);
  if (!apiKey) {
    throw new ApiError(
      '当前文件为扫描件或图片，需要调用 DeepSeek OCR 接口进行识别，但尚未配置 DeepSeek API Key。请在「设置 → 履约无忧配置」填写 DeepSeek OCR API Key（OCR 地址是官方 api.deepseek.com 时，也可以设置环境变量 DEEPSEEK_API_KEY）。',
      { code: 'OCR_KEY_MISSING' },
    );
  }
  if (!isHeaderSafeSecret(apiKey)) {
    throw new ApiError('DeepSeek OCR Key 含有空格或控制字符，请在「设置 → 履约无忧配置」重新填写。', { code: 'OCR_KEY_INVALID' });
  }

  const ocrUrl = (cfg?.ocrApiUrl || DEFAULT_CONFIG.ocrApiUrl).trim();
  const file =
    source && typeof source === 'object' && Buffer.isBuffer(source.bytes)
      ? source
      : await readLocalFile(source, { allowedExtensions: [...OCR_EXTENSIONS], maxBytes: MAX_READ_BYTES });
  const ext = extname(file.fileName).toLowerCase();
  const bytes = file.bytes;
  const mime = mimeTypeForFile(file.fileName);

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
    // 不跟随重定向：Key 和文件只发给填写的 OCR 地址。
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
        redirect: 'error',
      });
    } else {
      const form = new FormData();
      form.append('file', new Blob([bytes], { type: mime }), file.fileName);
      form.append('purpose', 'rich_layout_recognition');
      response = await fetchImpl(ocrUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json',
        },
        body: form,
        signal: controller.signal,
        redirect: 'error',
      });
    }

    const contentType = response.headers.get('content-type') || '';
    const rawText = await response.text();
    if (!response.ok) {
      // 不回显 OCR 服务返回的正文。
      if (response.status === 401 || response.status === 403) {
        throw new ApiError(`DeepSeek OCR Key 无效或没有权限（HTTP ${response.status}），请在「设置 → 履约无忧配置」检查 OCR Key。`, {
          status: response.status,
          code: 'OCR_UNAUTHORIZED',
        });
      }
      throw new ApiError(`DeepSeek OCR 接口调用失败（HTTP ${response.status}），请稍后重试。`, {
        status: response.status,
        code: 'OCR_FAILED',
      });
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
    // 底层异常（可能带出请求头里的 Key）不回显。
    throw new ApiError('DeepSeek OCR 请求失败（或 OCR 地址返回了重定向），请检查网络和 OCR 地址。', { code: 'OCR_ERROR' });
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
      `暂不支持该文件格式（${ext || '无扩展名'}）。支持格式：.pdf、.jpg、.jpeg、.png、.txt、.md。`,
      { code: 'UNSUPPORTED_FORMAT' },
    );
  }
  // 普通文件、不超过 20MB；只读一次，之后抽字和 OCR 都用这一份字节。
  const file = await readLocalFile(cleanPath, { allowedExtensions: [...SUPPORTED_EXTENSIONS], maxBytes: MAX_READ_BYTES });

  const fileName = basename(cleanPath);
  const apiClient = opts.apiClient || defaultApiClient;
  const signal = opts.signal;

  if (PLAIN_TEXT_EXTENSIONS.has(ext)) {
    const text = file.bytes.toString('utf8');
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
    const extracted = await apiClient.extractPdfText(cfg, file, {
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

    const ocr = await callDeepSeekOcr(file, cfg, signal, opts);
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

  // 图片（.jpg、.jpeg、.png）
  const ocr = await callDeepSeekOcr(file, cfg, signal, opts);
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
