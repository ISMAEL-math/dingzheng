import { buildStructuredDocument } from './textbook-structured.mjs';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { buildDocumentModel, extractQuestionRecords, isQuestionPublishable, matchPublishedQuestion, stableTextId, validateQuestionRecords } from './textbook-pipeline.mjs';

const MAX_BYTES = 200 * 1024 * 1024;
const MAX_PAGES = 200;
const STAGES = ['mineru', 'structure', 'extract', 'clean', 'quality'];
const SAFE_BOOK_ID = /^book_[a-f0-9]{24}$/u;
const EDITABLE_FIELDS = ['number', 'type', 'question', 'stem', 'options', 'correctAnswer', 'officialExplanation', 'questionPage', 'answerPage', 'explanationPage', 'sectionTitle', 'sectionPath'];

export function createTextbookLibrary({ directory, parseDocument, cleanBatch }) {
  if (typeof parseDocument !== 'function') throw new TypeError('缺少 PDF 解析适配器');
  const queue = [];
  const importsInProgress = new Map();
  let workerRunning = false;
  let initialized = false;

  const bookPath = bookId => join(directory, bookId);
  const metadataPath = bookId => join(bookPath(bookId), 'book.json');
  const questionsPath = bookId => join(bookPath(bookId), 'questions.json');
  const sourcePath = bookId => join(bookPath(bookId), 'source.pdf');
  const markdownPath = bookId => join(bookPath(bookId), 'mineru', 'full.md');

  async function atomicJson(path, value) {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, path);
  }

  async function saveMeta(book) {
    const { questions, ...meta } = book;
    await atomicJson(metadataPath(book.bookId), meta);
  }

  async function saveQuestions(book) {
    await atomicJson(questionsPath(book.bookId), book.questions || []);
    book.questionCount = (book.questions || []).length;
    book.verifiedCount = (book.questions || []).filter(question => question.status === 'verified').length;
    book.pendingReviewCount = (book.questions || []).filter(question => ['extracted', 'auto_paired', 'pending_review'].includes(question.status)).length;
    book.rejectedCount = (book.questions || []).filter(question => question.status === 'rejected').length;
  }

  async function readMeta(bookId) {
    if (!SAFE_BOOK_ID.test(String(bookId || ''))) return null;
    try { return JSON.parse(await readFile(metadataPath(bookId), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }

  async function readDetail(bookId) {
    const book = await readMeta(bookId);
    if (!book) return null;
    try { book.questions = JSON.parse(await readFile(questionsPath(bookId), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; book.questions = []; }
    return book;
  }

  function snapshot(book) {
    const { questions, ...meta } = book;
    return structuredClone(meta);
  }

  async function initialize() {
    if (initialized) return;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || !SAFE_BOOK_ID.test(entry.name)) continue;
      const book = await readMeta(entry.name);
      if (!book || !['queued', 'running'].includes(book.job?.status)) continue;
      book.job.status = 'failed';
      book.job.error = '本机服务在任务执行中重启。原始 PDF 和已完成步骤已保留，可从失败步骤重试。';
      book.job.failedStage = book.job.stage || 'mineru';
      book.job.updatedAt = Date.now();
      book.processingStatus = 'failed';
      book.processingError = book.job.error;
      await saveMeta(book);
    }
    initialized = true;
  }

  async function listBooks({ includeArchived = false } = {}) {
    await initialize();
    const books = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || !SAFE_BOOK_ID.test(entry.name)) continue;
      const book = await readMeta(entry.name);
      if (book && (includeArchived || !book.archived)) books.push(book);
    }
    return books.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }

  function schedule(bookId, config, startStage) {
    queue.push({ bookId, config: { ...config }, startStage });
    setImmediate(pump);
  }

  async function pump() {
    if (workerRunning) return;
    workerRunning = true;
    try {
      while (queue.length) {
        const task = queue.shift();
        await runJob(task.bookId, task.config, task.startStage);
      }
    } finally {
      workerRunning = false;
      if (queue.length) setImmediate(pump);
    }
  }

  async function createImport(options = {}) {
    const bytes = options.bytes;
    if (!Buffer.isBuffer(bytes) || !bytes.length) return importBook(options);
    const fingerprint = createHash('sha256').update(bytes).digest('hex');
    const inProgress = importsInProgress.get(fingerprint);
    if (inProgress) return { ...(await inProgress), duplicate: true };
    const task = importBook({ ...options, fingerprint });
    importsInProgress.set(fingerprint, task);
    try { return await task; }
    finally { if (importsInProgress.get(fingerprint) === task) importsInProgress.delete(fingerprint); }
  }

  async function importBook({ bytes, fileName, pageCount = 0, mineruApiKey = '', modelProvider = '', model = '', apiKey = '', hasModelCredentials = false, fingerprint: suppliedFingerprint = '' }) {
    await initialize();
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_BYTES || !bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'))) {
      const error = new Error('文件不是有效 PDF，或超过 200 MB。'); error.status = 400; throw error;
    }
    if (Number.isFinite(pageCount) && pageCount > MAX_PAGES) { const error = new Error(`教材最多支持 ${MAX_PAGES} 页。`); error.status = 413; throw error; }
    const safeName = String(fileName || '教材.pdf').replace(/[\\/\0\r\n]/gu, '_').slice(0, 180);
    if (!/\.pdf$/iu.test(safeName)) { const error = new Error('仅支持 PDF 文件。'); error.status = 415; throw error; }
    const fingerprint = suppliedFingerprint || createHash('sha256').update(bytes).digest('hex');
    const bookId = `book_${fingerprint.slice(0, 24)}`;
    const existing = await readMeta(bookId);
    if (existing) {
      let restored = false;
      if (existing.archived) {
        existing.archived = false;
        existing.archivedAt = null;
        existing.processingStatus = existing.published ? 'published' : (existing.job?.status === 'completed' ? 'needs_review' : existing.job?.status || 'queued');
        existing.updatedAt = Date.now();
        await saveMeta(existing);
        restored = true;
      }
      if (existing.job?.status === 'failed' && !existing.archived) {
        const failedStage = STAGES.includes(existing.job.failedStage) ? existing.job.failedStage : 'mineru';
        existing.job.status = 'queued';
        existing.job.error = '';
        existing.job.failedStage = '';
        existing.job.updatedAt = Date.now();
        existing.processingStatus = 'queued';
        existing.processingError = '';
        await saveMeta(existing);
        schedule(bookId, { mineruApiKey, modelProvider, model, apiKey, hasModelCredentials }, failedStage);
      }
      return { book: existing, duplicate: true, restored };
    }
    const sameTitle = (await listBooks({ includeArchived: true })).filter(book => book.title === safeName.replace(/\.pdf$/iu, ''));
    const version = sameTitle.reduce((max, book) => Math.max(max, Number(book.version) || 1), 0) + 1;
    const now = Date.now();
    const book = {
      bookId,
      title: safeName.replace(/\.pdf$/iu, ''),
      fileName: safeName,
      fileFormat: 'PDF',
      version,
      fingerprint,
      sizeBytes: bytes.length,
      pageCount: Number.isInteger(pageCount) && pageCount > 0 ? pageCount : null,
      createdAt: now,
      updatedAt: now,
      archived: false,
      published: false,
      processingStatus: 'queued',
      processingError: '',
      warnings: [],
      sections: [],
      questionCount: 0,
      verifiedCount: 0,
      pendingReviewCount: 0,
      rejectedCount: 0,
      cleaningStatus: 'pending',
      job: { id: stableTextId('job', bookId, 24), status: 'queued', stage: 'upload', completedStages: ['upload'], failedStage: '', error: '', progress: { completed: 0, total: 0 }, createdAt: now, updatedAt: now },
    };
    await mkdir(bookPath(bookId), { recursive: true, mode: 0o700 });
    await writeFile(sourcePath(bookId), bytes, { flag: 'wx', mode: 0o600 });
    await saveMeta(book);
    schedule(bookId, { mineruApiKey, modelProvider, model, apiKey, hasModelCredentials }, 'mineru');
    return { book: snapshot(book), duplicate: false };
  }

  async function updateStage(book, stage, message = '') {
    book.job.stage = stage;
    book.job.message = message;
    book.job.updatedAt = Date.now();
    book.updatedAt = Date.now();
    await saveMeta(book);
  }

  async function failJob(book, stage, error) {
    const message = String(error?.message || error || '教材处理失败').slice(0, 1200);
    book.job.status = 'failed';
    book.job.failedStage = stage;
    book.job.error = message;
    book.job.updatedAt = Date.now();
    book.processingStatus = 'failed';
    book.processingError = message;
    book.updatedAt = Date.now();
    await saveMeta(book);
  }

  async function runJob(bookId, config, startStage) {
    const book = await readDetail(bookId);
    if (!book || book.archived) return;
    let stage = startStage || 'mineru';
    const startIndex = Math.max(0, STAGES.indexOf(stage));
    try {
      book.job.status = 'running';
      book.job.error = '';
      book.job.failedStage = '';
      book.processingStatus = 'processing';
      book.processingError = '';
      await saveMeta(book);
      const bytes = await readFile(sourcePath(bookId));
      let markdown = '';
      if (startIndex <= 0) {
        stage = 'mineru'; await updateStage(book, stage, '正在提交 PDF 到 MinerU 并等待解析结果');
        const parsed = await parseDocument({ bytes, fileName: book.fileName, pageCount: book.pageCount || 0, apiKey: config.mineruApiKey || '' });
        markdown = typeof parsed === 'string' ? parsed : String(parsed?.markdown || '');
        if (!markdown.trim()) throw new Error('MinerU 没有返回可用的 Markdown 内容。');
        await mkdir(join(bookPath(bookId), 'mineru'), { recursive: true, mode: 0o700 });
        await writeFile(markdownPath(bookId), markdown, { mode: 0o600 });
        if (parsed && typeof parsed === 'object' && Buffer.isBuffer(parsed.archive)) await writeFile(join(bookPath(bookId), 'mineru', 'result.zip'), parsed.archive, { mode: 0o600 });
        if (parsed && typeof parsed === 'object' && Array.isArray(parsed.files)) {
          for (const file of parsed.files) {
            const name = String(file.name || '').replace(/\\/gu, '/').split('/').filter(part => part && part !== '.' && part !== '..').join('/');
            if (!name || name.length > 180 || !Buffer.isBuffer(file.data)) continue;
            const target = join(bookPath(bookId), 'mineru', 'files', name);
            await mkdir(join(target, '..'), { recursive: true, mode: 0o700 });
            await writeFile(target, file.data, { mode: 0o600 });
          }
        }
        book.job.completedStages = [...new Set([...(book.job.completedStages || []), 'mineru'])];
        await saveMeta(book);
      }
      if (startIndex > 0) markdown = await readFile(markdownPath(bookId), 'utf8');

      let document;
      if (startIndex <= 1) {
        stage = 'structure'; await updateStage(book, stage, '正在提取章节、页码和内容片段');
        const filesRoot = join(bookPath(bookId), 'mineru', 'files');
        let contentFile;
        try { contentFile = (await readdir(filesRoot, { recursive: true })).sort().find(name => name.endsWith('_content_list.json') || name === 'content_list.json'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        document = contentFile
          ? buildStructuredDocument(JSON.parse(await readFile(join(filesRoot, contentFile), 'utf8')), book.pageCount || 0)
          : buildDocumentModel(markdown, book.pageCount || 0);
        if (document.pageCount > MAX_PAGES) throw new Error(`MinerU 识别到 ${document.pageCount} 页，超过 ${MAX_PAGES} 页上限。`);
        await atomicJson(join(bookPath(bookId), 'document-pages.json'), document.pages);
        book.pageCount = document.pageCount;
        book.pageNumbersKnown = document.pageNumbersKnown;
        book.structureVersion = 2;
        if (document.pageNumbersKnown) book.warnings = (book.warnings || []).filter(w => !w.includes('没有明确的页码标记'));
        const unscoped = [...new Set(document.pages.flatMap(page => page.blocks).filter(block => block.region === 'answer' && !block.group).map(block => block.pageNumber))];
        if (unscoped.length) book.warnings = [...new Set([...(book.warnings || []), `PDF 第 ${unscoped.join('、')} 页答案区缺少可靠练习组，请核对原图及 OCR。`])];
        book.sections = document.headings;
        if (!document.pageNumbersKnown) book.warnings = [...new Set([...(book.warnings || []), 'MinerU 输出没有明确的页码标记，来源页码暂时不可靠。'])];
        book.job.completedStages = [...new Set([...(book.job.completedStages || []), 'structure'])];
        await saveMeta(book);
      } else {
        document = { pages: JSON.parse(await readFile(join(bookPath(bookId), 'document-pages.json'), 'utf8')), headings: book.sections || [], pageCount: book.pageCount, pageNumbersKnown: book.pageNumbersKnown };
      }

      if (startIndex <= 2) {
        stage = 'extract'; await updateStage(book, stage, '正在按题目与答案区结构切分候选题');
        book.questions = extractQuestionRecords(document, bookId);
        await saveQuestions(book);
        book.job.completedStages = [...new Set([...(book.job.completedStages || []), 'extract'])];
        await saveMeta(book);
      } else {
        book.questions = JSON.parse(await readFile(questionsPath(bookId), 'utf8'));
      }

      if (startIndex <= 3) {
        stage = 'clean';
        if (typeof cleanBatch !== 'function' || !config.model || !config.hasModelCredentials) {
          book.cleaningStatus = 'skipped';
          book.cleaningNote = '没有可用的大模型凭证或模型，规则提取结果已保留；可在设置中配置后重试此步骤。所有题目均需人工核验。';
          book.job.completedStages = [...new Set([...(book.job.completedStages || []), 'clean'])];
          await updateStage(book, stage, '跳过 AI 清洗；保留规则提取结果供人工核验');
        } else if (book.questions.length) {
          await updateStage(book, stage, '正在分批清洗题干、选项和答案关联建议');
          const batchSize = 5;
          const total = Math.ceil(book.questions.length / batchSize);
          book.job.progress = { completed: 0, total };
          await saveMeta(book);
          for (let index = 0; index < book.questions.length; index += batchSize) {
            const batch = book.questions.slice(index, index + batchSize);
            const suggestions = await cleanBatch({ questions: batch, document, config });
            const suggestionMap = new Map((Array.isArray(suggestions) ? suggestions : []).filter(item => item && typeof item.questionId === 'string').map(item => [item.questionId, item]));
            book.questions = book.questions.map(question => {
              const suggestion = suggestionMap.get(question.questionId);
              return suggestion ? { ...question, aiSuggestion: sanitizeSuggestion(suggestion, question) } : question;
            });
            await saveQuestions(book);
            book.job.progress = { completed: Math.min(total, Math.floor(index / batchSize) + 1), total };
            book.job.updatedAt = Date.now();
            await saveMeta(book);
          }
          book.cleaningStatus = 'completed';
          book.cleaningNote = 'AI 结果仅作为清洗草稿；没有自动标记为已核验，也不会自动用于判题。';
          book.job.completedStages = [...new Set([...(book.job.completedStages || []), 'clean'])];
        }
      } else {
        book.questions = JSON.parse(await readFile(questionsPath(bookId), 'utf8'));
      }

      if (startIndex <= 4) {
        stage = 'quality'; await updateStage(book, stage, '正在检查题目完整性、答案、页码与重复记录');
        book.questions = validateQuestionRecords(book.questions);
        await saveQuestions(book);
        book.job.completedStages = [...new Set([...(book.job.completedStages || []), 'quality'])];
      }
      book.job.status = 'completed';
      book.job.stage = 'review';
      book.job.message = '解析与质量检查已完成，题库记录等待人工核验';
      book.job.completedAt = Date.now();
      book.job.updatedAt = Date.now();
      book.processingStatus = 'needs_review';
      book.processingError = '';
      if (!book.questions.length) book.warnings = [...new Set([...(book.warnings || []), '未识别到可靠的题目候选，请检查 MinerU 原始 Markdown。'])];
      await saveMeta(book);
    } catch (error) {
      await failJob(book, stage, error);
    }
  }

  function sanitizeSuggestion(suggestion, question) {
    const result = { questionId: question.questionId, createdAt: Date.now(), uncertainty: Array.isArray(suggestion.uncertainty) ? suggestion.uncertainty.filter(item => typeof item === 'string').slice(0, 8) : [] };
    if (typeof suggestion.question === 'string' && suggestion.question.trim()) result.question = suggestion.question.slice(0, 12000);
    if (Array.isArray(suggestion.options)) result.options = suggestion.options.filter(option => option && typeof option.marker === 'string' && typeof option.content === 'string').slice(0, 8).map(option => ({ marker: option.marker.slice(0, 4), content: option.content.slice(0, 3000) }));
    if (typeof suggestion.type === 'string' && ['single_choice', 'multiple_choice', 'fill_blank', 'true_false', 'subjective'].includes(suggestion.type)) result.type = suggestion.type;
    const quote = typeof suggestion.evidenceQuote === 'string' ? suggestion.evidenceQuote.slice(0, 1000) : '';
    if (quote && (question.sourceQuote || '').includes(quote)) result.evidenceQuote = quote;
    result.note = result.evidenceQuote ? '草稿包含可回查的原文引用；请对照原 PDF 核验。' : 'AI 清洗草稿没有通过原文引用校验，仅供参考。';
    return result;
  }

  async function retry(bookId, config = {}) {
    const book = await readDetail(bookId);
    if (!book || book.archived) return null;
    if (book.job?.status === 'queued' || book.job?.status === 'running') return snapshot(book);
    let startStage = STAGES.includes(book.job?.failedStage) ? book.job.failedStage : 'mineru';
    if (book.structureVersion !== 2 && STAGES.indexOf(startStage) > 1 && !book.questions.some(q => ['verified', 'rejected'].includes(q.status))) startStage = 'structure';
    book.job.status = 'queued'; book.job.error = ''; book.job.failedStage = ''; book.job.message = '等待重试'; book.job.updatedAt = Date.now(); book.processingStatus = 'queued'; book.processingError = '';
    await saveMeta(book);
    schedule(bookId, config, startStage);
    return snapshot(book);
  }

  async function updateQuestion(bookId, questionId, patch = {}) {
    const book = await readDetail(bookId);
    if (!book) return null;
    if (['queued', 'running'].includes(book.job?.status)) throw new Error('教材仍在处理中，请完成后再编辑题库记录。');
    const index = book.questions.findIndex(question => question.questionId === questionId);
    if (index < 0) return null;
    const before = structuredClone(book.questions[index]);
    const question = { ...before };
    for (const field of EDITABLE_FIELDS) if (patch[field] !== undefined) question[field] = patch[field];
    if (typeof question.question !== 'string' || question.question.length > 12000) throw new Error('题干无效或超过长度限制。');
    if (!Array.isArray(question.options) || question.options.length > 8 || question.options.some(option => !option || typeof option.marker !== 'string' || typeof option.content !== 'string')) throw new Error('选项格式无效。');
    for (const field of ['questionPage', 'answerPage', 'explanationPage']) if (question[field] !== null && question[field] !== undefined && (!Number.isInteger(question[field]) || question[field] < 1 || question[field] > (book.pageCount || MAX_PAGES))) throw new Error(`${field} 页码无效。`);
    const action = patch.action === 'verify' ? 'verified' : patch.action === 'reject' ? 'rejected' : 'pending_review';
    question.issues = validateQuestionRecords([{ ...question, issues: [], status: 'pending_review' }])[0].issues;
    if (action === 'verified') {
      const checked = validateQuestionRecords([{ ...question, issues: [], status: 'pending_review' }])[0];
      if (!String(checked.correctAnswer || '').trim()) throw new Error('请先填写教材标准答案，再标记为已核验。');
      if (!Number.isInteger(checked.questionPage) || !Number.isInteger(checked.answerPage)) throw new Error('请填写题目页码和答案来源页码后再核验。');
      if (checked.issues.some(issue => /题干为空|无效选项|选项字母重复|题干过短|合并了多道题/u.test(issue))) throw new Error(`仍有阻止核验的问题：${checked.issues.join('、')}`);
      question.issues = checked.issues;
      question.status = 'verified';
      question.verifiedAt = Date.now();
    } else {
      question.status = action;
      question.verifiedAt = null;
    }
    question.verificationHistory = [...(before.verificationHistory || []), { at: Date.now(), action, before: historySnapshot(before), after: historySnapshot(question) }];
    book.questions[index] = question;
    book.updatedAt = Date.now();
    await saveQuestions(book); await saveMeta(book);
    return question;
  }

  async function publish(bookId, published) {
    const book = await readDetail(bookId);
    if (!book || book.archived) return null;
    if (published && book.job?.status !== 'completed') throw new Error('教材处理完成后才能发布题库。');
    if (published && !book.questions.some(isQuestionPublishable)) throw new Error('没有满足发布条件的已核验题目。');
    book.published = Boolean(published);
    book.publishedAt = published ? Date.now() : null;
    book.processingStatus = published ? 'published' : (book.questions.length ? 'needs_review' : 'needs_review');
    book.updatedAt = Date.now();
    await saveMeta(book);
    return snapshot(book);
  }

  async function remove(bookId, retainHistory = false) {
    const book = await readDetail(bookId);
    if (!book) return null;
    if (['queued', 'running'].includes(book.job?.status)) throw new Error('教材仍在处理中，请等待任务结束后再删除或归档。');
    if (retainHistory) {
      book.archived = true;
      book.published = false;
      book.archivedAt = Date.now();
      book.processingStatus = 'archived';
      book.updatedAt = Date.now();
      await saveMeta(book);
      return { archived: true };
    }
    await rm(bookPath(bookId), { recursive: true, force: true });
    return { archived: false };
  }

  async function getFile(bookId, kind) {
    if (!SAFE_BOOK_ID.test(String(bookId || ''))) return null;
    const paths = { pdf: sourcePath(bookId), markdown: markdownPath(bookId), archive: join(bookPath(bookId), 'mineru', 'result.zip') };
    const path = paths[kind];
    if (!path) return null;
    try { const data = await readFile(path); return { data, path }; }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }

  async function getKnowledge(bookId) {
    const book = await readMeta(bookId);
    if (!book || book.archived) return null;
    try {
      const pages = JSON.parse(await readFile(join(bookPath(bookId), 'document-pages.json'), 'utf8'));
      const records = JSON.parse(await readFile(questionsPath(bookId), 'utf8'));
      const revision = stableTextId('knowledge', JSON.stringify([pages, records]), 24);
      return { bookId, revision, questionRecords: records.filter(q => q.status !== 'rejected'), title: book.title, fileName: book.fileName, pageCount: book.pageCount, sections: book.sections || [], pages: pages.map(page => ({ number: page.number, headingPath: page.headingPath || [], text: String(page.content || '').slice(0, 50000) })).filter(page => page.text.trim()) };
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }

  async function getQuestion(questionId) {
    for (const book of await listBooks({ includeArchived: true })) {
      if (!book.archived || book.questionCount) {
        const detail = await readDetail(book.bookId);
        const question = detail?.questions?.find(item => item.questionId === questionId);
        if (question) return { book: snapshot(detail), question };
      }
    }
    return null;
  }

  async function match(input) {
    const books = [];
    for (const meta of await listBooks()) {
      if (!meta.published || meta.archived) continue;
      const book = await readDetail(meta.bookId);
      if (book) books.push(book);
    }
    const result = matchPublishedQuestion(input, books);
    if (result.status === 'matched') return { status: 'matched', score: result.score, book: snapshot(result.book), question: result.question };
    return result;
  }

  async function exportSnapshot(bookId) {
    const book = await readDetail(bookId);
    if (!book) return null;
    return snapshot(book);
  }

  return { initialize, listBooks, readDetail, createImport, retry, updateQuestion, publish, remove, getFile, getKnowledge, getQuestion, match, exportSnapshot };
}

function historySnapshot(question) {
  return Object.fromEntries(['question', 'options', 'correctAnswer', 'officialExplanation', 'questionPage', 'answerPage', 'explanationPage', 'status'].map(field => [field, structuredClone(question[field] ?? null)]));
}

export { MAX_BYTES as MAX_TEXTBOOK_BYTES, MAX_PAGES as MAX_TEXTBOOK_PAGES, isQuestionPublishable };
