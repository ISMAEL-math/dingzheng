import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { unzipSync, strFromU8 } from 'fflate';
import { embedTexts, rankVectors } from './rag-index.mjs';
import { CodexAuth, CodexError } from './codex-auth.mjs';
import { codexCompletion, listCodexModels } from './codex-provider.mjs';
import { createTextbookLibrary, MAX_TEXTBOOK_BYTES, MAX_TEXTBOOK_PAGES } from './textbook-library.mjs';

const root = fileURLToPath(new URL('./', import.meta.url));
const codexAuth = new CodexAuth({ directory: join(root, '.local', 'codex-auth') });
try {
  const env = await readFile(join(root, '.env'), 'utf8');
  for (const line of env.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
} catch {}

const textbookLibrary = createTextbookLibrary({
  directory: join(root, '.local', 'textbook-library'),
  parseDocument: options => parseWithMinerU({ ...options, includeArtifacts: true }),
  cleanBatch: cleanTextbookBatch,
});
await textbookLibrary.initialize();

const mime = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.mjs':'text/javascript; charset=utf-8', '.wasm':'application/wasm', '.woff2':'font/woff2', '.woff':'font/woff', '.json':'application/json; charset=utf-8', '.svg':'image/svg+xml' };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/codex/')) return handleCodex(req, res, url);
  if (req.method === 'GET' && url.pathname === '/api/config') {
    return send(res, 200, { hasServerKey: Boolean(process.env.SILICONFLOW_API_KEY), hasMineruKey: Boolean(process.env.MINERU_API_KEY), baseUrl: process.env.SILICONFLOW_BASE_URL || 'https://api.siliconflow.cn/v1' });
  }
  if (req.method === 'GET' && url.pathname === '/api/models') {
    const subType = url.searchParams.get('sub_type') || '';
    if (!['chat', 'embedding'].includes(subType)) return send(res, 400, { error: { message: '仅支持读取 chat 或 embedding 模型列表。' } });
    const apiKey = req.headers.authorization?.replace(/^Bearer\s+/i, '') || process.env.SILICONFLOW_API_KEY;
    if (!apiKey) return send(res, 401, { error: { message: '请先填写硅基流动 API Key。' } });
    try {
      const base = (process.env.SILICONFLOW_BASE_URL || 'https://api.siliconflow.cn/v1').replace(/\/$/, '');
      const upstream = await fetch(`${base}/models?sub_type=${encodeURIComponent(subType)}`, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(20_000) });
      const body = await upstream.text();
      res.writeHead(upstream.status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(body);
    } catch (error) {
      return send(res, 502, { error: { message: error.message || '读取硅基流动模型列表失败。' } });
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/mineru/parse') {
    try {
      const bytes = await readRawBody(req, 200 * 1024 * 1024);
      const fileName = decodeURIComponent(req.headers['x-file-name'] || 'document.pdf').replace(/[\\/\0]/g, '_');
      const pageCount = Number(req.headers['x-pdf-pages'] || 0);
      if (!bytes.length || !bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'))) return send(res, 400, { error: { message: '无效的 PDF 文件' } });
      const markdown = await parseWithMinerU({ bytes, fileName, pageCount, apiKey: req.headers['x-mineru-api-key'] || '' });
      return send(res, 200, { markdown });
    } catch (error) {
      return send(res, error.status || 502, { error: { message: error.message || 'MinerU 解析失败' } });
    }
  }
  if (url.pathname === '/api/textbooks' && req.method === 'GET') {
    try { return send(res, 200, { books: await textbookLibrary.listBooks() }); }
    catch (error) { return send(res, 500, { error: { message: error.message || '读取教材库失败' } }); }
  }
  if (url.pathname === '/api/textbooks' && req.method === 'POST') {
    if (!isLocalAppRequest(req)) return send(res, 403, { error: { message: '请从本机钉正页面导入教材。' } });
    try {
      const bytes = await readRawBody(req, MAX_TEXTBOOK_BYTES);
      const fileName = decodeURIComponent(req.headers['x-file-name'] || '教材.pdf');
      const pageCount = Number(req.headers['x-pdf-pages'] || 0);
      const result = await textbookLibrary.createImport({
        bytes, fileName, pageCount,
        mineruApiKey: req.headers['x-mineru-api-key'] || '',
        modelProvider: req.headers['x-clean-provider'] || '',
        model: req.headers['x-clean-model'] || '',
        apiKey: req.headers.authorization?.replace(/^Bearer\s+/i, '') || '',
        hasModelCredentials: Boolean(req.headers.authorization || process.env.SILICONFLOW_API_KEY || (req.headers['x-clean-provider'] === 'codex')),
      });
      return send(res, result.duplicate ? 200 : 202, result);
    } catch (error) { return send(res, error.status || 500, { error: { message: error.message || '教材导入失败' } }); }
  }
  if (req.method === 'POST' && url.pathname === '/api/textbooks/match') {
    if (!isLocalAppRequest(req)) return send(res, 403, { error: { message: '请从本机钉正页面发起请求。' } });
    try { return send(res, 200, await textbookLibrary.match(await readBody(req))); }
    catch (error) { return send(res, 500, { error: { message: error.message || '教材题库匹配失败' } }); }
  }
  const textbookQuestionMatch = url.pathname.match(/^\/api\/textbooks\/question\/(question_[a-f0-9]{32})$/u);
  if (req.method === 'GET' && textbookQuestionMatch) {
    try { const value = await textbookLibrary.getQuestion(textbookQuestionMatch[1]); return value ? send(res, 200, value) : send(res, 404, { error: { message: '题库记录不存在。' } }); }
    catch (error) { return send(res, 500, { error: { message: error.message || '读取题库记录失败' } }); }
  }
  const textbookRoute = url.pathname.match(/^\/api\/textbooks\/(book_[a-f0-9]{24})(?:\/(.*))?$/u);
  if (textbookRoute) {
    const [, bookId, action = ''] = textbookRoute;
    if (req.method !== 'GET' && !isLocalAppRequest(req)) return send(res, 403, { error: { message: '请从本机钉正页面管理教材。' } });
    try {
      if (req.method === 'GET' && !action) { const book = await textbookLibrary.readDetail(bookId); return book ? send(res, 200, book) : send(res, 404, { error: { message: '教材不存在。' } }); }
      if (req.method === 'GET' && action === 'knowledge') { const knowledge = await textbookLibrary.getKnowledge(bookId); return knowledge ? send(res, 200, knowledge) : send(res, 404, { error: { message: '教材解析内容尚未生成。' } }); }
      if (req.method === 'GET' && action.startsWith('source/')) {
        const kind = action.slice('source/'.length);
        const file = await textbookLibrary.getFile(bookId, kind);
        if (!file) return send(res, 404, { error: { message: '原始文件不存在。' } });
        const contentType = kind === 'pdf' ? 'application/pdf' : kind === 'archive' ? 'application/zip' : 'text/markdown; charset=utf-8';
        const fileName = kind === 'pdf' ? 'source.pdf' : kind === 'archive' ? 'mineru-result.zip' : 'mineru-full.md';
        res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': file.data.length, 'Content-Disposition': `attachment; filename="${fileName}"`, 'Cache-Control': 'no-store' });
        return res.end(file.data);
      }
      if (req.method === 'POST' && action === 'retry') {
        const config = {
          mineruApiKey: req.headers['x-mineru-api-key'] || '',
          modelProvider: req.headers['x-clean-provider'] || '',
          model: req.headers['x-clean-model'] || '',
          apiKey: req.headers.authorization?.replace(/^Bearer\s+/i, '') || '',
          hasModelCredentials: Boolean(req.headers.authorization || process.env.SILICONFLOW_API_KEY || req.headers['x-clean-provider'] === 'codex'),
        };
        const book = await textbookLibrary.retry(bookId, config);
        return book ? send(res, 202, { book }) : send(res, 404, { error: { message: '教材不存在。' } });
      }
      if (req.method === 'POST' && (action === 'publish' || action === 'unpublish')) {
        const book = await textbookLibrary.publish(bookId, action === 'publish');
        return book ? send(res, 200, { book }) : send(res, 404, { error: { message: '教材不存在。' } });
      }
      const questionMatch = action.match(/^questions\/(question_[a-f0-9]{32})$/u);
      if (req.method === 'PATCH' && questionMatch) {
        const question = await textbookLibrary.updateQuestion(bookId, questionMatch[1], await readBody(req));
        return question ? send(res, 200, { question }) : send(res, 404, { error: { message: '题库记录不存在。' } });
      }
      if (req.method === 'DELETE' && !action) {
        const body = await readBody(req);
        const result = await textbookLibrary.remove(bookId, body.retainHistory === true);
        return result ? send(res, 200, result) : send(res, 404, { error: { message: '教材不存在。' } });
      }
      return send(res, 404, { error: { message: '教材接口不存在。' } });
    } catch (error) { return send(res, error.status || 400, { error: { message: error.message || '教材操作失败' } }); }
  }
  if (req.method === 'POST' && url.pathname === '/api/rag/search') {
    try {
      const body = await readBody(req);
      return send(res, 200, { results: await rankVectors(body) });
    } catch (error) {
      return send(res, 400, { error: { message: error.message || '知识库检索失败' } });
    }
  }
  if (req.method === 'POST' && ['/api/chat/completions', '/api/embeddings'].includes(url.pathname)) {
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    try {
      const body = await readBody(req);
      const apiKey = req.headers.authorization?.replace(/^Bearer\s+/i, '') || process.env.SILICONFLOW_API_KEY;
      if (!apiKey) return send(res, 401, { error: { message: '请先在设置中填写硅基流动 API Key。' } });
      const base = (process.env.SILICONFLOW_BASE_URL || 'https://api.siliconflow.cn/v1').replace(/\/$/, '');
      if (url.pathname === '/api/embeddings') {
        const input = Array.isArray(body.input) ? body.input : [body.input];
        const vectors = await embedTexts({ model: body.model, apiKey, baseURL: base, texts: input, signal: controller.signal });
        return send(res, 200, { object: 'list', model: body.model, data: vectors.map((embedding, index) => ({ object: 'embedding', index, embedding })) });
      }
      const upstream = await fetch(`${base}${url.pathname.replace('/api', '')}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }, body: JSON.stringify(body), signal: controller.signal
      });
      if (url.pathname === '/api/chat/completions' && body.stream === true && upstream.ok) {
        res.writeHead(upstream.status, {
          'Content-Type': upstream.headers.get('content-type') || 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no'
        });
        if (!upstream.body) return res.end();
        try {
          for await (const chunk of upstream.body) {
            if (res.destroyed) break;
            if (!res.write(Buffer.from(chunk))) await new Promise(resolve => { const done = () => { res.off('drain', done); res.off('close', done); resolve(); }; res.once('drain', done); res.once('close', done); });
          }
        } finally {
          if (!res.writableEnded && !res.destroyed) res.end();
        }
        return;
      }
      const text = await upstream.text();
      res.writeHead(upstream.status, { 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store' });
      return res.end(text);
    } catch (error) {
      if (controller.signal.aborted || res.destroyed) return;
      return send(res, 500, { error: { message: error.message || '请求硅基流动失败' } });
    }
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error:'Method not allowed' });
  let pathname;
  try { pathname = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname); }
  catch { return send(res, 400, 'Invalid path'); }
  // Serve the pinned local renderer and its fonts/workers; no runtime CDN dependency.
  if (pathname.startsWith('/vendor/pdfjs/')) {
    const asset = pathname.slice('/vendor/pdfjs/'.length);
    if (!/^(build|cmaps|standard_fonts|wasm|iccs)\/[A-Za-z0-9_.-]+$/.test(asset)) return send(res,404,'Not found');
    try { const data=await readFile(join(root,'node_modules/pdfjs-dist',asset));res.writeHead(200,{'Content-Type':mime[extname(asset)]||'application/octet-stream'});return res.end(data); }
    catch { return send(res,404,'PDF renderer missing; run npm install'); }
  }
  const safe = normalize(pathname).replace(/^([/\\]|\.\.(?:[/\\]|$))+/, '');
  try {
    const data = await readFile(join(root, 'public', safe));
    res.writeHead(200, { 'Content-Type': mime[extname(safe)] || 'application/octet-stream', 'Cache-Control':'no-cache' });
    res.end(data);
  } catch { send(res, 404, 'Not found'); }
});
server.listen(Number(process.env.PORT) || 4173, '127.0.0.1', () => console.log(`钉正已启动：http://localhost:${Number(process.env.PORT) || 4173}`));

async function handleCodex(req, res, url) {
  // This is a local app. Reject DNS rebinding and cross-origin requests before
  // starting OAuth, revealing account labels, or spending a user's allowance.
  const host = req.headers.host || '';
  const allowedHosts = [`localhost:${Number(process.env.PORT) || 4173}`, `127.0.0.1:${Number(process.env.PORT) || 4173}`];
  if (!allowedHosts.includes(host) || req.headers['x-dingzheng-client'] !== '1' || (req.headers.origin && req.headers.origin !== `http://${host}`) || req.headers['sec-fetch-site'] === 'cross-site') return send(res, 403, { error: { message: '请从本机钉正页面发起请求。' } });
  const controller = new AbortController();
  res.on('close', () => { if (!res.writableEnded) controller.abort(); });
  try {
    if (req.method === 'GET' && url.pathname === '/api/codex/status') return send(res, 200, await codexAuth.status());
    if (req.method === 'GET' && url.pathname === '/api/codex/models') return send(res, 200, { data: await listCodexModels(codexAuth) });
    if (req.method === 'POST' && url.pathname === '/api/codex/login') { const body = await readBody(req); return send(res, 200, await codexAuth.startLogin(body.accountId || null)); }
    if (req.method === 'POST' && url.pathname === '/api/codex/cancel-login') { await codexAuth.cancelLogin(); return send(res, 200, { ok: true }); }
    if (req.method === 'POST' && url.pathname === '/api/codex/logout') return send(res, 200, await codexAuth.disconnect());
    if (req.method !== 'POST' || url.pathname !== '/api/codex/chat/completions') return send(res, 404, { error: { message: '接口不存在。' } });
    const body = await readBody(req);
    const streaming = body.stream === true;
    let sentText = false;
    const writePacket = async packet => {
      if (res.destroyed || controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      if (!res.headersSent) res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' });
      if (!res.write(`data: ${JSON.stringify(packet)}\n\n`)) await new Promise(resolve => { const done = () => { res.off('drain', done); res.off('close', done); resolve(); }; res.once('drain', done); res.once('close', done); });
    };
    const result = await codexCompletion(codexAuth, body, { signal: controller.signal, ...(streaming ? { onDelta: async content => { sentText = true; await writePacket({ choices: [{ index: 0, delta: { content } }] }); } } : {}) });
    if (!streaming) return send(res, 200, result);
    if (!sentText && result.choices[0].message.content) await writePacket({ choices: [{ index: 0, delta: { content: result.choices[0].message.content } }] });
    await writePacket({ choices: [{ index: 0, delta: {}, finish_reason: result.choices[0].finish_reason }], usage: result.usage });
    res.end('data: [DONE]\n\n');
  } catch (error) {
    if (res.destroyed || controller.signal.aborted) return;
    const message = error instanceof CodexError ? error.message : 'Codex 连接失败，请检查本机网络后重试。';
    const payload = { error: { message, code: error instanceof CodexError ? error.code : 'codex_connection_error' } };
    if (res.headersSent) res.end(`data: ${JSON.stringify(payload)}\n\n`);
    else send(res, error instanceof CodexError ? error.status : 502, payload);
  }
}

function send(res, status, data) { res.writeHead(status, { 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store' }); res.end(typeof data === 'string' ? data : JSON.stringify(data)); }
function readBody(req) { return new Promise((resolve, reject) => { let raw = ''; req.on('data', chunk => { raw += chunk; if (raw.length > 35 * 1024 * 1024) { reject(new Error('文件太大，请每次上传较小的文件。')); req.destroy(); } }); req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { reject(new Error('请求格式无效')); } }); req.on('error', reject); }); }
function readRawBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) {
        const error = new Error('PDF 不能超过 200 MB');
        error.status = 413;
        reject(error);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function parseWithMinerU({ bytes, fileName, pageCount, apiKey = '', includeArtifacts = false }) {
  const controller = AbortSignal.timeout(12 * 60_000);
  const token = apiKey || process.env.MINERU_API_KEY;
  if (token) {
    const submit = await mineruJson('https://mineru.net/api/v4/file-urls/batch', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        files: [{ name: fileName, data_id: randomUUID(), is_ocr: true }],
        model_version: 'vlm',
        enable_formula: true,
        enable_table: true,
        language: 'ch',
      }),
      signal: controller,
    });
    const batchId = submit.data?.batch_id;
    const uploadUrl = submit.data?.file_urls?.[0];
    if (!batchId || !uploadUrl) throw new Error(submit.msg || 'MinerU 未能创建解析任务');
    const uploaded = await fetch(uploadUrl, { method: 'PUT', body: bytes, signal: controller });
    if (!uploaded.ok) throw new Error(`MinerU 文件上传失败（${uploaded.status}）`);
    const started = Date.now();
    while (Date.now() - started < 10 * 60_000) {
      await new Promise(resolve => setTimeout(resolve, 2500));
      const result = await mineruJson(`https://mineru.net/api/v4/extract-results/batch/${encodeURIComponent(batchId)}`, {
        headers: { Authorization: `Bearer ${token}` }, signal: controller,
      });
      const task = result.data?.extract_result?.[0];
      if (task?.state === 'failed') throw new Error(task.err_msg || 'MinerU 解析失败');
      if (task?.state === 'done' && task.full_zip_url) {
        const archiveResponse = await fetch(task.full_zip_url, { signal: controller });
        if (!archiveResponse.ok) throw new Error('无法下载 MinerU 解析结果');
        const archive = Buffer.from(await archiveResponse.arrayBuffer());
        const files = unzipSync(new Uint8Array(archive));
        const markdownFile = Object.keys(files).find(path => /(^|\/)full\.md$/i.test(path));
        if (!markdownFile) throw new Error('MinerU 结果中缺少 Markdown 文本');
        const markdown = strFromU8(files[markdownFile]);
        if (!includeArtifacts) return markdown;
        return { markdown, archive, files: Object.entries(files).map(([name, data]) => ({ name, data: Buffer.from(data) })) };
      }
    }
    throw new Error('MinerU 解析时间过长，请稍后重试');
  }

  if (bytes.length > 10 * 1024 * 1024 || pageCount > 20) {
    throw new Error('该 PDF 超过 MinerU 免密解析额度。请在设置中填写 MinerU API Key 后重试。');
  }
  const submit = await mineruJson('https://mineru.net/api/v1/agent/parse/file', {
    method: 'POST',
    body: JSON.stringify({ file_name: fileName, language: 'ch', enable_table: true, is_ocr: true, enable_formula: true }),
    signal: controller,
  });
  const taskId = submit.data?.task_id;
  const uploadUrl = submit.data?.file_url;
  if (!taskId || !uploadUrl) throw new Error(submit.msg || 'MinerU 未能创建解析任务');
  const uploaded = await fetch(uploadUrl, { method: 'PUT', body: bytes, signal: controller });
  if (!uploaded.ok) throw new Error(`MinerU 文件上传失败（${uploaded.status}）`);
  const started = Date.now();
  while (Date.now() - started < 10 * 60_000) {
    await new Promise(resolve => setTimeout(resolve, 2500));
    const result = await mineruJson(`https://mineru.net/api/v1/agent/parse/${encodeURIComponent(taskId)}`, { signal: controller });
    const task = result.data;
    if (task?.state === 'failed') throw new Error(task.err_msg || 'MinerU 解析失败');
    if (task?.state === 'done' && task.markdown_url) {
      const markdownResponse = await fetch(task.markdown_url, { signal: controller });
      if (!markdownResponse.ok) throw new Error('无法下载 MinerU 解析结果');
      const markdown = await markdownResponse.text();
      return includeArtifacts ? { markdown, files: [{ name: 'full.md', data: Buffer.from(markdown) }] } : markdown;
    }
  }
  throw new Error('MinerU 解析时间过长，请稍后重试');
}

async function mineruJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.code !== 0) throw new Error(result.msg || result.message || `MinerU 请求失败（${response.status}）`);
  return result;
}

function isLocalAppRequest(req) {
  const host = req.headers.host || '';
  const port = Number(process.env.PORT) || 4173;
  if (![ `localhost:${port}`, `127.0.0.1:${port}` ].includes(host)) return false;
  if (req.headers.origin && req.headers.origin !== `http://${host}`) return false;
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  return req.headers['x-dingzheng-client'] === '1';
}

async function cleanTextbookBatch({ questions, document, config }) {
  const excerpts = questions.map(question => {
    const pageNumbers = [...new Set([question.questionPage, question.answerPage, question.explanationPage].filter(Number.isInteger))];
    const pageText = pageNumbers.map(number => {
      const page = document.pages.find(item => item.number === number);
      return page ? `【第 ${number} 页原文】\n${String(page.content || '').slice(0, 2800)}` : '';
    }).filter(Boolean).join('\n\n');
    return {
      questionId: question.questionId,
      number: question.number,
      sectionPath: question.sectionPath,
      rawQuestion: question.sourceQuote,
      parsedOptions: question.options,
      parsedAnswer: question.correctAnswer || null,
      answerExcerpt: question.answerSourceQuote || null,
      sourcePages: pageNumbers,
      pageExcerpt: pageText.slice(0, 6000),
    };
  });
  const body = {
    model: config.model,
    temperature: 0,
    max_tokens: 3500,
    messages: [
      { role: 'system', content: '你是教材 OCR 清洗助手，只能把输入中的原文整理为结构化草稿。不得补写、推断或纠正题目事实、选项、标准答案、官方解析、页码。不要输出答案字段。保留原始意思与公式。若不能从原文确认则将字段设为 null，并写入 uncertainty。evidenceQuote 必须逐字来自 rawQuestion。只返回 JSON：{"records":[{"questionId":"原 ID","question":"清洗草稿或 null","options":[{"marker":"A","content":"原文内容"}],"type":"single_choice|multiple_choice|fill_blank|true_false|subjective 或 null","evidenceQuote":"原文短引","uncertainty":[]}]}。' },
      { role: 'user', content: JSON.stringify({ records: excerpts }) },
    ],
  };
  const signal = AbortSignal.timeout(120_000);
  let response;
  if (config.modelProvider === 'codex') {
    response = await codexCompletion(codexAuth, body, { signal });
  } else {
    const apiKey = config.apiKey || process.env.SILICONFLOW_API_KEY;
    if (!apiKey) throw new Error('AI 清洗缺少模型 API Key');
    const base = (process.env.SILICONFLOW_BASE_URL || 'https://api.siliconflow.cn/v1').replace(/\/$/u, '');
    const upstream = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal,
    });
    const payload = await upstream.json().catch(() => ({}));
    if (!upstream.ok) throw new Error(payload.error?.message || `AI 清洗请求失败（${upstream.status}）`);
    response = payload;
  }
  let content = response.choices?.[0]?.message?.content;
  if (Array.isArray(content)) content = content.map(item => item.text || '').join('\n');
  if (typeof content !== 'string') throw new Error('AI 清洗没有返回可读 JSON');
  content = content.replace(/^```(?:json)?\s*/iu, '').replace(/```\s*$/u, '').trim();
  const start = content.indexOf('{'), end = content.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('AI 清洗结果不是有效 JSON');
  const parsed = JSON.parse(content.slice(start, end + 1));
  return Array.isArray(parsed.records) ? parsed.records : [];
}
