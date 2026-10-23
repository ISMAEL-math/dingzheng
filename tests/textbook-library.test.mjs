import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDocumentModel, extractQuestionRecords, isQuestionPublishable, matchPublishedQuestion } from '../textbook-pipeline.mjs';
import { createTextbookLibrary } from '../textbook-library.mjs';

const pdfBytes = label => Buffer.from(`%PDF-1.7\n${label}\n%%EOF`);
const markdown = `# 第 1 章 操作系统基础
## 习题
<!-- PageNumber="5" -->
1. 关于进程，下列说法正确的是？
A. 进程是资源分配的基本单位
B. 进程是 CPU 调度的最小单位
<!-- PageNumber="8" -->
## 参考答案与解析
1. A 进程是资源分配的基本单位，线程是 CPU 调度的最小单位。
`;

async function waitFor(service, bookId, predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const book = await service.readDetail(bookId);
    if (predicate(book)) return book;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  return service.readDetail(bookId);
}

async function createLibrary(parseDocument = async () => markdown, cleanBatch) {
  const directory = await mkdtemp(join(tmpdir(), 'dingzheng-textbooks-'));
  const service = createTextbookLibrary({ directory, parseDocument, cleanBatch });
  await service.initialize();
  return { directory, service };
}

test('document model preserves MinerU pages and question headings', () => {
  const document = buildDocumentModel(markdown, 10);
  assert.equal(document.pageCount, 10);
  assert.equal(document.pageNumbersKnown, true);
  const questionPage = document.pages.find(page => page.number === 5);
  assert.deepEqual(questionPage.blocks.find(block => block.kind === 'text').headingPath, ['第 1 章 操作系统基础', '习题']);
  assert.equal(document.pages.find(page => page.number === 8).number, 8);
});

test('question extraction pairs a unique answer row and keeps answer text out of the question', () => {
  const document = buildDocumentModel(markdown, 10);
  const [question] = extractQuestionRecords(document, 'book_test');
  assert.ok(question);
  assert.match(question.question, /关于进程/u);
  assert.doesNotMatch(question.question, /线程是 CPU 调度/u);
  assert.deepEqual(question.options, [
    { marker: 'A', content: '进程是资源分配的基本单位' },
    { marker: 'B', content: '进程是 CPU 调度的最小单位' },
  ]);
  assert.equal(question.correctAnswer, 'A');
  assert.match(question.officialExplanation, /线程是 CPU 调度/u);
  assert.equal(question.questionPage, 5);
  assert.equal(question.answerPage, 8);
  assert.equal(question.status, 'auto_paired');
});

test('only verified, sourced textbook questions can be published and matched exactly', () => {
  const base = { question: '关于进程，下列说法正确的是？', type: 'single_choice', options: [{ marker: 'A', content: '进程是资源分配的基本单位' }, { marker: 'B', content: '进程是 CPU 调度的最小单位' }], correctAnswer: 'A', questionPage: 5, answerPage: 8, status: 'verified', issues: [] };
  assert.equal(isQuestionPublishable(base), true);
  assert.equal(isQuestionPublishable({ ...base, questionPage: null }), false);
  assert.equal(isQuestionPublishable({ ...base, status: 'auto_paired' }), false);
  const books = [{ bookId: 'book_test', title: '操作系统', published: true, archived: false, questions: [{ ...base, questionId: 'question_test' }] }];
  assert.equal(matchPublishedQuestion({ question: '关于进程，下列说法正确的是？' }, books).status, 'matched');
  assert.equal(matchPublishedQuestion({ question: '这道进程题的答案是什么？' }, books).status, 'none');
});

test('import persists PDF and MinerU artifacts, updates questions, publishes and matches', async t => {
  const { directory, service } = await createLibrary(async () => ({ markdown, archive: Buffer.from('zip'), files: [{ name: 'images/page-5.png', data: Buffer.from('image') }] }));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const imported = await service.createImport({ bytes: pdfBytes('book A'), fileName: '操作系统.pdf', pageCount: 10 });
  const completed = await waitFor(service, imported.book.bookId, book => ['completed', 'failed'].includes(book.job.status));
  assert.equal(completed.job.status, 'completed');
  assert.equal(completed.questions.length, 1);
  assert.equal(completed.questions[0].status, 'auto_paired');
  const duplicate = await service.createImport({ bytes: pdfBytes('book A'), fileName: '操作系统.pdf', pageCount: 10 });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.book.bookId, imported.book.bookId);
  const pdf = await service.getFile(imported.book.bookId, 'pdf');
  const zip = await service.getFile(imported.book.bookId, 'archive');
  const source = await service.getFile(imported.book.bookId, 'markdown');
  assert.match(pdf.data.toString(), /%PDF/u);
  assert.equal(zip.data.toString(), 'zip');
  assert.match(source.data.toString(), /操作系统基础/u);
  await assert.rejects(service.publish(imported.book.bookId, true), /没有满足发布条件/u);
  const question = completed.questions[0];
  const verified = await service.updateQuestion(imported.book.bookId, question.questionId, { action: 'verify' });
  assert.equal(verified.status, 'verified');
  assert.equal((await service.publish(imported.book.bookId, true)).published, true);
  assert.equal((await service.match({ question: question.question })).status, 'matched');
});

test('concurrent upload of the same PDF is idempotent and model cleanup never overwrites an answer', async t => {
  let cleanCalls = 0;
  const { directory, service } = await createLibrary(async () => markdown, async ({ questions }) => {
    cleanCalls++;
    return [{ questionId: questions[0].questionId, question: questions[0].question, correctAnswer: 'B', evidenceQuote: questions[0].sourceQuote, uncertainty: [] }];
  });
  t.after(() => rm(directory, { recursive: true, force: true }));
  const options = { bytes: pdfBytes('concurrent'), fileName: '操作系统.pdf', pageCount: 10, modelProvider: 'siliconflow', model: 'test-model', apiKey: 'test-key', hasModelCredentials: true };
  const [first, second] = await Promise.all([service.createImport(options), service.createImport(options)]);
  assert.equal(first.book.bookId, second.book.bookId);
  assert.deepEqual([first.duplicate, second.duplicate].sort(), [false, true]);
  const completed = await waitFor(service, first.book.bookId, book => ['completed', 'failed'].includes(book.job.status));
  assert.equal(completed.job.status, 'completed');
  assert.equal(cleanCalls, 1);
  assert.equal(completed.questions[0].correctAnswer, 'A');
  assert.ok(completed.questions[0].aiSuggestion);
  assert.equal(completed.questions[0].status, 'auto_paired');
});

test('a failed stage can resume from its checkpoint and same-title imports get a new version', async t => {
  let parseCount = 0;
  const { directory, service } = await createLibrary(async () => {
    parseCount++;
    if (parseCount === 1) throw new Error('MinerU 暂时不可用');
    return markdown;
  });
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = await service.createImport({ bytes: pdfBytes('version 1'), fileName: '操作系统.pdf', pageCount: 10 });
  const failed = await waitFor(service, first.book.bookId, book => book.job.status === 'failed');
  assert.equal(failed.job.failedStage, 'mineru');
  await service.retry(first.book.bookId);
  const retried = await waitFor(service, first.book.bookId, book => ['completed', 'failed'].includes(book.job.status));
  assert.equal(retried.job.status, 'completed');
  const second = await service.createImport({ bytes: pdfBytes('version 2'), fileName: '操作系统.pdf', pageCount: 10 });
  const secondDone = await waitFor(service, second.book.bookId, book => ['completed', 'failed'].includes(book.job.status));
  assert.equal(secondDone.version, 2);
  assert.equal(parseCount, 3);
});

test('archived textbooks are hidden from matching but remain readable for history', async t => {
  const { directory, service } = await createLibrary(async () => markdown);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const imported = await service.createImport({ bytes: pdfBytes('archive'), fileName: '操作系统.pdf', pageCount: 10 });
  const completed = await waitFor(service, imported.book.bookId, book => book.job.status === 'completed');
  const questionId = completed.questions[0].questionId;
  await service.remove(imported.book.bookId, true);
  assert.equal((await service.listBooks()).length, 0);
  assert.ok(await service.getQuestion(questionId));
  assert.equal((await service.match({ question: completed.questions[0].question })).status, 'none');
});
