import { extractStructuredQuestions } from './textbook-structured.mjs';
import { createHash } from 'node:crypto';

const QUESTION_HEADING = /习题|练习|自测|试题|题目|作业|测验|测试|思考题|精选/u;
const ANSWER_HEADING = /答案|解答|解析|参考答案|习题答案/u;
const QUESTION_CUE = /[？?]|下列|哪些|哪项|选择|简述|说明|计算|求|试述|为什么|是否|如何|指出|判断|填空|若\b|设\b|假设|比较/u;

export function stableTextId(prefix, value, length = 24) {
  return `${prefix}_${createHash('sha256').update(String(value)).digest('hex').slice(0, length)}`;
}

function pageSegments(markdown) {
  const text = String(markdown || '').replace(/\r\n?/g, '\n');
  const marker = /<!--\s*PageNumber\s*=\s*["']?(\d+)["']?\s*-->/giu;
  const matches = [...text.matchAll(marker)];
  if (!matches.length) return [{ number: null, text }];
  const pages = [];
  const prelude = text.slice(0, matches[0].index).trim();
  if (prelude) pages.push({ number: null, text: prelude });
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index + matches[i][0].length;
    const end = matches[i + 1]?.index ?? text.length;
    pages.push({ number: Number(matches[i][1]), text: text.slice(start, end).trim() });
  }
  return pages;
}

export function buildDocumentModel(markdown, declaredPageCount = 0) {
  const segments = pageSegments(markdown);
  const headingPath = [];
  const pages = segments.map((segment, index) => {
    const blocks = [];
    for (const line of segment.text.split('\n')) {
      const rawText = line.trim();
      if (!rawText) continue;
      const heading = rawText.match(/^(#{1,6})\s+(.+)$/u);
      if (heading) {
        const level = heading[1].length;
        headingPath.splice(level - 1);
        headingPath[level - 1] = heading[2].replace(/\s+#+\s*$/u, '').trim();
        blocks.push({ kind: 'heading', level, text: headingPath[level - 1], headingPath: headingPath.filter(Boolean), rawText, pageNumber: segment.number });
      } else {
        const kind = /^\s*\|.*\|\s*$/u.test(rawText) ? 'table'
          : /^\s*[-*+]\s/u.test(rawText) ? 'list'
          : /!\[[^\]]*\]\([^)]*\)/u.test(rawText) ? 'image'
          : 'text';
        blocks.push({ kind, text: rawText, headingPath: headingPath.filter(Boolean), rawText, pageNumber: segment.number });
      }
    }
    const pageNumber = segment.number ?? (segments.length === 1 && Number.isInteger(declaredPageCount) && declaredPageCount === 1 ? 1 : null);
    const path = headingPath.filter(Boolean);
    return {
      number: pageNumber,
      ordinal: index + 1,
      headingPath: [...path],
      content: blocks.map(block => block.text).join('\n'),
      blocks: blocks.map(block => ({ ...block, pageNumber })),
      sourceLocator: segment.number ? `mineru:page:${segment.number}` : `mineru:segment:${index + 1}`,
    };
  });
  const headings = [];
  const seen = new Set();
  for (const page of pages) for (const block of page.blocks) if (block.kind === 'heading') {
    const key = `${block.text}:${block.pageNumber ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    headings.push({ title: block.text, level: block.level, headingPath: [...page.headingPath], pageNumber: block.pageNumber });
  }
  const actualPages = pages.filter(page => page.number !== null).length;
  const highestPageNumber = Math.max(0, ...pages.map(page => Number(page.number) || 0));
  return {
    pages,
    headings,
    pageCount: Number(declaredPageCount) || highestPageNumber || actualPages || pages.length,
    pageNumbersKnown: actualPages > 0,
  };
}

function answerSection(path, local) {
  return (path || []).some(title => ANSWER_HEADING.test(title)) || /^\s*(?:参考答案|标准答案|答案与解析|答案|解答|解析)(?:区|篇|[:：\s]|$)/u.test(String(local || ''));
}

function questionSection(path) { return QUESTION_HEADING.test(path.join(' ')); }

function marker(line) {
  const match = String(line).match(/^\s*(?:\*\*)?(?:第\s*)?(\d{1,3})\s*[.．、)）]\s*(.*)$/u);
  return match ? { number: match[1].replace(/^0+(?=\d)/u, ''), rest: match[2] } : null;
}

function choiceCount(text) {
  return new Set([...String(text).matchAll(/(?:^|\s)([A-FＡ-Ｆ])\s*[.．、)）]/giu)].map(match => match[1].toUpperCase())).size;
}

function normalizeAnswer(value) {
  return String(value || '').normalize('NFKC').toUpperCase().replace(/[\s,，、/／和及与]+/gu, '');
}

function parseAnswerRow(row, pageNumber, headingPath) {
  const match = row.match(/^\s*(?:第\s*)?(\d{1,3})\s*[.．、)）:：]\s*(?:参考答案|答案|解答)?\s*[:：]?\s*([A-FＡ-Ｆ]{1,8})(?=\s|[。；;]|$)(.*)$/u);
  if (!match) return null;
  const answer = normalizeAnswer(match[2]);
  if (!answer || !/^[A-F]+$/u.test(answer)) return null;
  return {
    number: match[1].replace(/^0+(?=\d)/u, ''),
    answer,
    text: [match[3].trim(), row.slice(match[0].length).trim()].filter(Boolean).join(' '),
    pageNumber,
    headingPath: [...headingPath],
  };
}

function splitInlineNumberedLines(lines) {
  const output = [];
  for (const line of lines) {
    const text = line.text;
    const matches = [...text.matchAll(/(?<!\S)(\d{1,3})\s*[.．、)）]\s*(?=[^\s])/gu)];
    if (matches.length < 2) { output.push(line); continue; }
    let start = 0;
    for (let index = 0; index < matches.length; index++) {
      const match = matches[index];
      const end = matches[index + 1]?.index ?? text.length;
      const part = text.slice(match.index, end).trim();
      if (part) output.push({ ...line, text: part });
      start = end;
    }
    if (!start) output.push(line);
  }
  return output;
}

function significantWords(value) {
  const normalized = String(value || '').normalize('NFKC').replace(/[\p{P}\p{S}\s\dA-F]/giu, '');
  const words = new Set();
  for (const match of normalized.matchAll(/[\p{Script=Han}]{2,}|[a-z]{3,}/giu)) {
    const word = match[0];
    if (!/^(?:下列|哪些|选择|正确|错误|不包括|包括|下述|试述|根据|本题|答案|解析|选项|下列说法)$/u.test(word)) words.add(word);
  }
  return words;
}

function overlapScore(questionText, answerText) {
  const questionWords = significantWords(questionText);
  if (!questionWords.size || !answerText) return 0;
  const answer = String(answerText).normalize('NFKC');
  let matches = 0;
  for (const word of questionWords) if (answer.includes(word)) matches++;
  return matches / questionWords.size;
}

function parseOptions(text) {
  const options = [];
  const regex = /(?:^|\s)([A-FＡ-Ｆ])\s*[.．、)）]\s*(.*?)(?=(?:\s+[A-FＡ-Ｆ]\s*[.．、)）])|$)/giu;
  for (const match of String(text || '').matchAll(regex)) {
    const marker = match[1].normalize('NFKC').toUpperCase();
    const content = match[2].trim().replace(/[。；;\s]+$/u, '');
    if (content) options.push({ marker, content });
  }
  return options;
}

export function extractQuestionRecords(document, bookId) {
  if (document.pages?.some(page => page.blocks?.some(block => block.region))) return extractStructuredQuestions(document, bookId);
  const flatLines = [];
  for (const page of document.pages || []) {
    let path = [...(page.headingPath || [])];
    for (const block of page.blocks || []) {
      if (block.kind === 'heading') path = [...(block.headingPath || path)];
      if (block.kind !== 'heading') flatLines.push({ text: block.rawText || block.text || '', pageNumber: page.number, headingPath: [...path], kind: block.kind });
    }
  }
  const lines = splitInlineNumberedLines(flatLines);
  const answerRows = [];
  const questionStarts = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const localAnswer = answerSection(line.headingPath, line.text);
    if (localAnswer) {
      const answer = parseAnswerRow(line.text, line.pageNumber, line.headingPath);
      if (answer) answerRows.push({ ...answer, lineIndex: index });
      continue;
    }
    const numbered = marker(line.text);
    if (!numbered) continue;
    const context = lines.slice(index, Math.min(lines.length, index + 7))
      .filter(candidate => !answerSection(candidate.headingPath, candidate.text))
      .map(candidate => candidate.text).join(' ');
    const options = choiceCount(context);
    const cue = QUESTION_CUE.test(context) || /(?:（\s*）|\(\s*\)|_{2,}|…{2,})/u.test(context);
    if (!cue && options < 2 && !questionSection(line.headingPath)) continue;
    if (!cue && options < 2) continue;
    questionStarts.push({ index, number: numbered.number, firstText: numbered.rest, pageNumber: line.pageNumber, headingPath: [...line.headingPath] });
  }

  const candidates = [];
  for (let position = 0; position < questionStarts.length; position++) {
    const start = questionStarts[position];
    let end = questionStarts[position + 1]?.index ?? lines.length;
    const startPath = start.headingPath.join('\u0000');
    for (let cursor = start.index + 1; cursor < end; cursor++) {
      if (answerSection(lines[cursor].headingPath, lines[cursor].text) || lines[cursor].headingPath.join('\u0000') !== startPath) { end = cursor; break; }
    }
    const rawLines = lines.slice(start.index, end).map(line => line.text.trim()).filter(Boolean);
    if (!rawLines.length) continue;
    rawLines[0] = start.firstText || rawLines[0].replace(/^\s*(?:\*\*)?(?:第\s*)?\d{1,3}\s*[.．、)）]\s*/u, '');
    const rawText = rawLines.join('\n').trim();
    const options = parseOptions(rawText);
    const answerCandidates = answerRows.filter(row => row.number === start.number);
    let paired = null;
    if (answerCandidates.length === 1 && questionStarts.filter(item => item.number === start.number).length === 1) {
      const candidate = answerCandidates[0];
      const evidenceText = [candidate.text, ...lines.slice(candidate.lineIndex + 1, Math.min(lines.length, candidate.lineIndex + 5)).map(line => line.text)].join(' ');
      const pathWords = candidate.headingPath.filter(title => !ANSWER_HEADING.test(title)).join(' ');
      const hasEvidence = overlapScore(rawText, evidenceText) >= 0.18 || overlapScore(start.headingPath.join(' '), pathWords) >= 0.5;
      if (hasEvidence && candidate.pageNumber !== null) {
        paired = { answer: candidate.answer, answerPage: candidate.pageNumber, explanation: evidenceText.trim() || null, explanationPage: candidate.pageNumber };
      }
    }
    const stableInput = `${bookId}\n${start.headingPath.join(' › ')}\n${start.number}\n${rawText.normalize('NFKC').replace(/\s+/gu, '')}`;
    const questionId = stableTextId('question', stableInput, 32);
    const expectedChoiceMarkers = options.map(option => option.marker);
    const type = options.length >= 2 ? (/多选|不定项/u.test(`${start.headingPath.join(' ')} ${rawText}`) ? 'multiple_choice' : 'single_choice')
      : /填空/u.test(rawText) ? 'fill_blank'
      : /判断/u.test(rawText) ? 'true_false'
      : 'subjective';
    candidates.push({
      questionId,
      bookId,
      sectionId: stableTextId('section', `${bookId}\n${start.headingPath.join(' › ') || '未识别章节'}`, 20),
      sectionTitle: start.headingPath.at(-1) || '',
      sectionPath: start.headingPath,
      number: start.number,
      type,
      question: rawText,
      stem: rawText,
      options,
      optionMarkers: expectedChoiceMarkers,
      correctAnswer: paired?.answer || '',
      officialExplanation: paired?.explanation || '',
      questionPage: start.pageNumber,
      answerPage: paired?.answerPage ?? null,
      explanationPage: paired?.explanationPage ?? null,
      sourceQuote: rawText.slice(0, 3000),
      answerSourceQuote: paired ? `${paired.answer}${paired.explanation ? ` ${paired.explanation}` : ''}`.slice(0, 3000) : '',
      status: paired ? 'auto_paired' : 'pending_review',
      issues: [],
      aiSuggestion: null,
      verificationHistory: [],
      origin: { questionLocator: start.pageNumber ? `mineru:page:${start.pageNumber}` : null },
    });
  }
  return candidates;
}

export function validateQuestionRecords(questions) {
  const normalized = (questions || []).map(question => ({ ...question, issues: [...(question.issues || [])] }));
  const duplicateText = new Map();
  for (const question of normalized) {
    const textKey = String(question.question || '').normalize('NFKC').replace(/[\p{P}\p{S}\s]/gu, '').toLowerCase();
    if (textKey) duplicateText.set(textKey, [...(duplicateText.get(textKey) || []), question.questionId]);
  }
  for (const question of normalized) {
    const options = Array.isArray(question.options) ? question.options : [];
    const markers = options.map(option => String(option.marker || '').toUpperCase());
    const add = issue => { if (!question.issues.includes(issue)) question.issues.push(issue); };
    if (!String(question.question || '').trim()) add('题干为空');
    if (String(question.question || '').trim().length < 4) add('题干过短，可能未完整提取');
    if (String(question.question || '').length > 12000) add('题干过长，可能合并了多道题');
    if (/\[?无法辨认\]?|�{2,}|\?{4,}/u.test(question.question || '')) add('题干包含 OCR 不确定内容');
    if (question.type === 'single_choice' || question.type === 'multiple_choice') {
      if (options.length < 2) add('选择题选项不足，需核验');
      if (new Set(markers).size !== markers.length) add('选项字母重复');
      const expected = options.map(option => option.marker).sort().join('');
      if (expected && !/^[A-F]+$/u.test(expected)) add('选项字母无法识别');
    }
    const answer = normalizeAnswer(question.correctAnswer);
    if (answer && question.type === 'single_choice' && (!/^[A-F]$/u.test(answer) || !markers.includes(answer))) add('答案包含无效选项');
    if (answer && question.type === 'multiple_choice' && ([...answer].some(letter => !markers.includes(letter)))) add('多选答案包含无效选项');
    if (!answer) add('未可靠关联标准答案');
    if (question.questionPage == null) add('题目来源页码未识别');
    if (answer && question.answerPage == null) add('答案来源页码未识别');
    const duplicates = duplicateText.get(String(question.question || '').normalize('NFKC').replace(/[\p{P}\p{S}\s]/gu, '').toLowerCase()) || [];
    if (duplicates.length > 1) add('检测到题干重复');
    if (!question.issues.length && question.status !== 'verified') question.status = question.correctAnswer ? 'auto_paired' : 'extracted';
    else if (question.status !== 'verified' && question.status !== 'rejected') question.status = 'pending_review';
  }
  return normalized;
}

export function isQuestionPublishable(question) {
  if (!question || question.status !== 'verified') return false;
  if (!String(question.question || '').trim() || !String(question.correctAnswer || '').trim()) return false;
  if (!Number.isInteger(question.questionPage) || !Number.isInteger(question.answerPage)) return false;
  if (question.issues?.some(issue => /为空|无效选项|字母重复|题干重复|题干过短|合并了多道题/u.test(issue))) return false;
  if (['single_choice', 'multiple_choice'].includes(question.type)) {
    const markers = new Set((question.options || []).map(option => option.marker));
    const answer = normalizeAnswer(question.correctAnswer);
    if (!markers.size || [...answer].some(letter => !markers.has(letter))) return false;
  }
  return true;
}

export function normalizeQuestionMatch(value) {
  return String(value || '').normalize('NFKC').replace(/^\s*(?:第\s*)?\d{1,3}\s*[.．、)）]\s*/u, '').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
}

export function matchPublishedQuestion(input, books) {
  const query = normalizeQuestionMatch(input?.question || input?.stem || '');
  if (!query || query.length < 8) return { status: 'none', candidates: [] };
  const matches = [];
  for (const book of books || []) {
    if (!book.published || book.archived) continue;
    for (const question of book.questions || []) {
      if (question.status !== 'verified' || !isQuestionPublishable(question)) continue;
      const stored = normalizeQuestionMatch(question.question || question.stem);
      if (stored && stored === query) matches.push({ book, question, score: 1 });
    }
  }
  if (matches.length === 1) return { status: 'matched', ...matches[0] };
  if (matches.length > 1) return { status: 'ambiguous', candidates: matches.map(({ book, question, score }) => ({ bookId: book.bookId, bookTitle: book.title, questionId: question.questionId, question: question.question, score })) };
  return { status: 'none', candidates: [] };
}
