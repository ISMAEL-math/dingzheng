import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { buildMarkdownChunks, buildPageChunks } from '../public/rag-structure.js';

const source = (await readFile(new URL('../public/pdf-workspace.js', import.meta.url), 'utf8'))
  .replace(/^import .*\n/gm, '').replace('export function', 'function');

function setup({ failExtract = false, failStorage = false, failEmbedding = false, failMineru = false, parser = 'text_only' } = {}) {
  const snapshots = [], embedTexts = [], extractCalls = [], opens = [], mineruCalls = [], notices = [];
  let embeddingBroken = failEmbedding, uuid = 0;
  const file = { name: '扫描资料.pdf', size: 100 };
  const pdf = { numPages: 3, fingerprints: ['fp'], destroy: async () => {} };
  const state = { sources: [], page: 'library', settings: { pdfParser: parser, embeddingModel: 'embed' } };
  const persist = () => { if (state.sources[0]) snapshots.push(structuredClone(state.sources[0])); if (failStorage) throw new Error('quota'); };
  const hooks = {
    esc: String, state: () => state, render() {},
    notify: message => notices.push(message),
    splitChunks: text => text ? [{ text }] : [], formatBytes: String, hasKey: () => true,
    file: async () => file,
    save: persist,
    add: async added => { state.sources = [added, ...state.sources]; persist(); },
    embed: async (texts, signal) => { embedTexts.push(...texts); if (embeddingBroken) throw new Error('embedding offline'); signal.throwIfAborted(); return texts.map(() => [1, 0]); },
    mineru: async sentFile => { mineruCalls.push(sentFile); if (failMineru) throw new Error('mineru offline'); return '# 标题\n\n第 1 页正文内容'; },
  };
  const ctx = vm.createContext({
    document: { getElementById: () => null, querySelector: () => null }, navigator: {}, console,
    AbortSignal, AbortController, setTimeout, clearTimeout, Blob, URL,
    crypto: { randomUUID: () => `uuid-${++uuid}` },
    MAX_PDF_BYTES: 200 * 1024 * 1024,
    openPdf: async sentFile => { opens.push(sentFile); return pdf; },
    extractPdfTextPages: async opened => { extractCalls.push(opened); if (failExtract) throw new Error('extract failed'); return ['第一页文字', '第二页文字', '第三页文字']; },
    buildMarkdownChunks, buildPageChunks, hooks,
  });
  vm.runInContext(source + '\nglobalThis.workspace=createPdfWorkspace(hooks);', ctx);
  return { workspace: ctx.workspace, state, snapshots, embedTexts, extractCalls, opens, mineruCalls, notices, recover: () => { embeddingBroken = false; } };
}

test('ingest extracts text, embeds chunks and persists each step', async () => {
  const a = setup();
  const result = await a.workspace.ingest({ name: '扫描资料.pdf', size: 100 });
  assert.equal(result.processingStatus, 'done');
  assert.ok(a.state.sources[0].chunks.length >= 3);
  assert.deepEqual(a.state.sources[0].chunks.map(chunk => chunk.pageNumber), [1, 2, 3]);
  assert.ok(a.state.sources[0].chunks.every(chunk => chunk.embedding));
  assert.equal(a.state.sources[0].embeddingModel, 'embed');
  assert.equal(a.workspace.busy(), false);
  assert.match(a.notices.at(-1), /已处理/);
});

test('extraction failure persists the failed status before stopping', async () => {
  const a = setup({ failExtract: true });
  await a.workspace.ingest({ name: '扫描资料.pdf', size: 100 });
  assert.equal(a.extractCalls.length, 1);
  assert.equal(a.embedTexts.length, 0);
  assert.equal(a.state.sources[0].processingStatus, 'error');
  assert.ok(a.snapshots.some(snapshot => snapshot.processingStatus === 'error'));
  assert.match(a.notices.at(-1), /资料处理失败/);
});

test('embedding failure preserves extracted pages and lexical content', async () => {
  const a = setup({ failEmbedding: true });
  const source = await a.workspace.ingest({ name: '扫描资料.pdf', size: 100 });
  assert.ok(source.pages.every(page => page.status === 'done'));
  assert.ok(source.chunks.length >= 3);
  assert.ok(source.chunks.every(chunk => !chunk.embedding));
  assert.match(source.processingError, /向量/);
  assert.match(source.chunks[0].text, /第一页文字/);
});

test('storage failure stops before any embedding calls', async () => {
  const a = setup({ failStorage: true });
  await a.workspace.ingest({ name: '扫描资料.pdf', size: 100 });
  assert.equal(a.embedTexts.length, 0);
  assert.equal(a.state.sources[0].processingStatus, 'processing');
  assert.match(a.notices.at(-1), /资料处理失败/);
});

test('oversized PDF is rejected before opening', async () => {
  const a = setup();
  await a.workspace.ingest({ name: '大文件.pdf', size: 200 * 1024 * 1024 + 1 });
  assert.equal(a.opens.length, 0);
  assert.equal(a.embedTexts.length, 0);
  assert.match(a.notices.at(-1), /200 MB/);
  await assert.rejects(() => a.workspace.parseAttachment({ name: '大文件.pdf', size: 200 * 1024 * 1024 + 1 }), /200 MB/);
  assert.equal(a.opens.length, 0);
});

test('parseAttachment reads page texts for chat context', async () => {
  const a = setup();
  const parsed = await a.workspace.parseAttachment({ name: '扫描资料.pdf', size: 100 });
  assert.equal(parsed.parser, 'text_only');
  assert.equal(parsed.pageCount, 3);
  assert.deepEqual(parsed.pages, ['第一页文字', '第二页文字', '第三页文字']);
  assert.match(parsed.text, /\[第 1 页\]/);
  assert.equal(a.opens.length, 1);
});

test('mineru failure records the failed step and keeps the source for retry', async () => {
  const a = setup({ failMineru: true, parser: 'mineru' });
  await a.workspace.ingest({ name: '扫描资料.pdf', size: 100 });
  assert.equal(a.mineruCalls.length, 1);
  assert.equal(a.state.sources[0].processingStatus, 'error');
  assert.equal(a.state.sources[0].parser, 'mineru');
  assert.ok(a.snapshots.some(snapshot => snapshot.processingStatus === 'error'));
});

test('storeParsedAttachment builds page-linked chunks and embeds them', async () => {
  const a = setup();
  const parsed = { parser: 'text_only', pages: ['甲页内容', '乙页内容', '丙页内容'], pageCount: 3, fingerprint: 'fp', text: '甲页内容\n\n乙页内容' };
  const stored = await a.workspace.storeParsedAttachment({ name: 'chat.pdf', size: 10 }, parsed);
  assert.equal(a.state.sources[0].id, stored.id);
  assert.deepEqual(stored.chunks.map(chunk => chunk.pageNumber), [1, 2, 3]);
  assert.ok(stored.chunks.every(chunk => chunk.embedding));
  assert.equal(stored.embeddingModel, 'embed');
  assert.equal(stored.structureVersion, 1);
  assert.equal(a.workspace.busy(), false);
  assert.match(a.notices.at(-1), /已加入知识库/);
});

test('reindex re-embeds stored chunks after the embedding service recovers', async () => {
  const a = setup({ failEmbedding: true });
  const source = await a.workspace.ingest({ name: '扫描资料.pdf', size: 100 });
  assert.match(source.processingError, /向量/);
  a.recover();
  a.embedTexts.length = 0;
  await a.workspace.reindex(a.state.sources[0].id);
  const repaired = a.state.sources[0];
  assert.ok(repaired.chunks.every(chunk => chunk.embedding));
  assert.equal(repaired.processingError, '');
  assert.ok(a.embedTexts.length >= 3);
  assert.match(a.notices.at(-1), /检索索引已更新/);
});
