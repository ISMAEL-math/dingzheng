import {openPdf, extractPdfTextPages, MAX_PDF_BYTES} from './pdf-engine.js';
import {buildMarkdownChunks, buildPageChunks} from './rag-structure.js';

export function createPdfWorkspace(h) {
  let job = false;
  const pageChunks = pages => buildPageChunks(pages);
  const addWarning = (source, message) => { source.processingWarning = [source.processingWarning, message].filter(Boolean).join(' '); };

  async function saveSource(source) {
    await h.save();
    h.render();
  }

  async function indexSource(source, signal) {
    source.indexing = true;
    h.render();
    try {
      const chunks = source.chunks || [];
      const model = h.state().settings.embeddingModel;
      for (let start = 0; start < chunks.length; start += 8) {
        const batch = chunks.slice(start, start + 8);
        const vectors = await h.embed(batch.map(chunk => chunk.text), signal);
        if (vectors.length !== batch.length) throw new Error('向量数量不匹配');
        batch.forEach((chunk, index) => {
          chunk.embedding = vectors[index];
          chunk.embeddingModel = model;
        });
      }
      source.embeddingModel = model;
    } finally {
      source.indexing = false;
    }
    await saveSource(source);
  }

  async function process(source, file, pdf, parser) {
    job = true;
    source.parser = parser;
    source.processingStatus = 'processing';
    source.processingError = '';
    source.processingWarning = '';
    try {
      await saveSource(source);
      let texts;
      if (parser === 'mineru') {
        const markdown = await h.mineru(file, pdf.numPages);
        if (!markdown.trim()) throw new Error('没有提取到可用内容');
        const structured = buildMarkdownChunks(markdown, pdf.numPages);
        source.pages = Array.from({length: pdf.numPages}, (_, index) => ({
          number: index + 1, status: 'done', rotation: 0, text: '',
        }));
        source.chunks = structured.chunks;
        source.headings = structured.headings;
        source.tocPages = structured.tocPages;
        source.structureVersion = 1;
        if (structured.chunks.some(chunk => !chunk.pageNumber)) addWarning(source, '已保留章节标题；解析结果没有明确页码标记，回答可能无法精确引用页码。');
      } else {
        texts = await extractPdfTextPages(pdf);
        if (!texts.some(text => text.trim())) {
          throw new Error('这份 PDF 没有可直接提取的文字，请切换为 MinerU');
        }
        const missingPages = texts.filter(text => !text.trim()).length;
        if (missingPages) source.processingWarning = `${missingPages} 页未检测到文字层，扫描图片内容未加入检索。切换为 MinerU 后点击“重试”可重新处理。`;
        source.pages = texts.map((text, index) => ({
          number: index + 1,
          status: 'done',
          rotation: 0,
          text,
        }));
        const structured = pageChunks(texts);
        source.chunks = structured.chunks;
        source.headings = structured.headings;
        source.tocPages = structured.tocPages;
        source.structureVersion = 1;
      }
      if (!source.chunks.length) throw new Error('没有提取到可用于检索的文字');
      if (!source.headings.length) addWarning(source, '未识别出明确的章节标题；整书目录问题可能无法准确回答，请先在预览内容中检查解析结果。');
      source.processingStatus = 'done';
      source.processingError = '';
      await saveSource(source);
      try {
        await indexSource(source, AbortSignal.timeout(180_000));
      } catch (error) {
        source.processingError = `向量索引暂不可用：${error.message}`;
        await saveSource(source);
      }
    } catch (error) {
      source.processingStatus = 'error';
      source.processingError = error.message || '解析失败';
      await saveSource(source);
      throw error;
    } finally {
      job = false;
    }
  }

  async function parseAttachment(file) {
    if (!file || file.size > MAX_PDF_BYTES) throw new Error('PDF 不能超过 200 MB');
    const parser = h.state().settings.pdfParser === 'mineru' ? 'mineru' : 'text_only';
    let pdf;
    try {
      h.notify('正在读取 PDF 内容…');
      pdf = await openPdf(file);
      let text, pages = [];
      if (parser === 'mineru') {
        text = await h.mineru(file, pdf.numPages);
      } else {
        pages = await extractPdfTextPages(pdf);
        text = pages.map((page, index) => page.trim() ? `[第 ${index + 1} 页]\n${page}` : '').filter(Boolean).join('\n\n');
        if (!text) throw new Error('这份 PDF 没有可提取的文字，请在设置中选择 MinerU');
      }
      if (!text?.trim()) throw new Error('没有读取到可用内容');
      return {name: file.name, text: text.trim(), pages, parser, pageCount: pdf.numPages, fingerprint: pdf.fingerprints[0]};
    } finally {
      await pdf?.destroy();
    }
  }

  async function storeParsedAttachment(file, parsed) {
    if (job) throw new Error('正在处理另一份资料，请稍后再试');
    if (!h.hasKey()) throw new Error('请先配置 API Key，再建立知识库索引');
    job = true;
    const parser = parsed.parser === 'mineru' ? 'mineru' : 'text_only';
    const pages = parsed.pages || [];
    const source = {
      id: crypto.randomUUID(), name: file.name.replace(/\.pdf$/i, ''), fileName: file.name,
      sizeBytes: file.size, sizeLabel: h.formatBytes(file.size), createdAt: Date.now(),
      pdfVersion: 1, parser, processingStatus: 'processing', processingError: '', processingWarning: '',
      fingerprint: parsed.fingerprint, pageCount: parsed.pageCount,
      pages: parser === 'text_only'
        ? pages.map((text, index) => ({number: index + 1, status: 'done', rotation: 0, text}))
        : Array.from({length: parsed.pageCount}, (_, index) => ({number: index + 1, status: 'done', rotation: 0, text: ''})),
      chunks: [],
    };
    const structured = parser === 'text_only' ? pageChunks(pages) : buildMarkdownChunks(parsed.text, parsed.pageCount);
    source.chunks = structured.chunks;
    source.headings = structured.headings;
    source.tocPages = structured.tocPages;
    source.structureVersion = 1;
    if (parser === 'mineru' && source.chunks.some(chunk => !chunk.pageNumber)) addWarning(source, '已保留章节标题；解析结果没有明确页码标记，回答可能无法精确引用页码。');
    try {
      if (!source.chunks.length) throw new Error('没有可加入知识库的文字');
      if (parser === 'text_only') {
        const missingPages = pages.filter(text => !text.trim()).length;
        if (missingPages) addWarning(source, `${missingPages} 页未检测到文字层，扫描图片内容未加入检索。`);
      }
      if (!source.headings.length) addWarning(source, '未识别出明确的章节标题；整书目录问题可能无法准确回答，请检查解析预览。');
      await h.add(source, file);
      navigator.storage?.persist?.().catch(() => {});
      h.render();
      try {
        await indexSource(source, AbortSignal.timeout(180_000));
      } catch (error) {
        source.processingError = `向量索引暂不可用：${error.message}`;
        await saveSource(source);
      }
      h.notify('资料已加入知识库');
      return source;
    } finally {
      job = false;
    }
  }

  async function ingest(file) {
    if (job) return h.notify('正在处理另一份资料，请稍后再试');
    if (!file || file.size > MAX_PDF_BYTES) return h.notify('PDF 不能超过 200 MB');
    if (!h.hasKey()) return h.notify('请先在偏好设置中配置 API Key');
    const parser = h.state().settings.pdfParser === 'mineru' ? 'mineru' : 'text_only';
    let pdf;
    try {
      const estimate = await navigator.storage?.estimate?.();
      if (estimate?.quota && estimate.quota - estimate.usage < file.size * 1.2) {
        throw new Error('本机存储空间不足，请先清理或导出资料');
      }
      h.notify('正在读取 PDF…');
      pdf = await openPdf(file);
      const source = {
        id: crypto.randomUUID(),
        name: file.name.replace(/\.pdf$/i, ''),
        fileName: file.name,
        sizeBytes: file.size,
        sizeLabel: h.formatBytes(file.size),
        createdAt: Date.now(),
        pdfVersion: 1,
        parser,
        processingStatus: 'processing',
        processingError: '',
        fingerprint: pdf.fingerprints[0],
        pageCount: pdf.numPages,
        pages: Array.from({length: pdf.numPages}, (_, index) => ({
          number: index + 1, status: 'pending', rotation: 0, text: '',
        })),
        chunks: [],
      };
      await h.add(source, file);
      navigator.storage?.persist?.().catch(() => {});
      h.render();
      h.notify(parser === 'mineru' ? '正在用 MinerU 解析并建立知识库…' : '正在提取文字并建立知识库…');
      await process(source, file, pdf, parser);
      h.notify('资料已处理并加入知识库');
      return source;
    } catch (error) {
      h.notify(`资料处理失败：${error.message}`);
    } finally {
      await pdf?.destroy();
    }
  }

  async function reprocess(sourceId) {
    if (job) return h.notify('正在处理另一份资料，请稍后再试');
    if (!h.hasKey()) return h.notify('请先在偏好设置中配置 API Key');
    const source = h.state().sources.find(item => item.id === sourceId);
    if (!source) return;
    const file = await h.file(source.id);
    if (!file) return h.notify('原 PDF 不在本机，请删除后重新上传');
    let pdf;
    try {
      pdf = await openPdf(file);
      source.pages = Array.from({length: pdf.numPages}, (_, index) => ({
        number: index + 1, status: 'pending', rotation: 0, text: '',
      }));
      source.chunks = [];
      source.headings = [];
      source.tocPages = [];
      delete source.structureVersion;
      await process(source, file, pdf, h.state().settings.pdfParser === 'mineru' ? 'mineru' : 'text_only');
      h.notify('资料已重新处理并加入知识库');
    } catch (error) {
      h.notify(`资料处理失败：${error.message}`);
    } finally {
      await pdf?.destroy();
    }
  }

  async function reindex(sourceId) {
    if (job) return h.notify('正在处理资料，请稍后再试');
    const source = h.state().sources.find(item => item.id === sourceId);
    if (!source?.chunks?.length) return h.notify('这份资料还没有可检索的内容');
    job = true;
    try {
      await indexSource(source, AbortSignal.timeout(180_000));
      source.processingError = '';
      await saveSource(source);
      h.notify('检索索引已更新');
    } catch (error) {
      source.processingError = `检索索引更新失败：${error.message}`;
      await saveSource(source);
      h.notify(`重建失败：${error.message}`);
    } finally {
      job = false;
      h.render();
    }
  }

  return {ingest, parseAttachment, storeParsedAttachment, reprocess, reindex, indexSource, busy: () => job};
}
