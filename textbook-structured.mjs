import { createHash } from 'node:crypto';
const id = (prefix, text) => `${prefix}_${createHash('sha256').update(text).digest('hex').slice(0, 32)}`;
const auxiliary = new Set(['header', 'footer', 'page_number', 'page_footnote', 'aside_text']);

// V1 content_list coordinates are retained verbatim (normalized to 0..1000).
export function buildStructuredDocument(items, declaredPageCount = 0) {
  if (!Array.isArray(items) || !items.length || items.some(x => !Number.isInteger(x.page_idx) || x.page_idx < 0)) throw new Error('MinerU content_list 页索引无效');
  const pages = new Map();
  const headings = [];
  let section = '', sectionTitle = '', region = 'body', group = '', type = '', serial = 0;
  for (const [index, item] of items.entries()) {
    const number = item.page_idx + 1;
    if (!pages.has(number)) pages.set(number, { number, ordinal: number, printedPage: null, blocks: [], headingPath: [], sourceLocator: `mineru:page:${number}` });
    const page = pages.get(number);
    const text = String(item.text ?? item.table_body ?? (item.list_items || []).join('\n') ?? '').trim();
    if (item.type === 'page_number') page.printedPage = text;
    if (auxiliary.has(item.type)) continue;
    const numberedHeading = text.match(/^(\d+(?:\.\d+)+)\s+(.+)$/u);
    const exercise = /^(?:\d+(?:\.\d+)+\s+)?(?:本节|本章)?(?:习题精选|习题|练习题|练习|自测题)\s*$/u.test(text);
    const answer = /^(?:\d+(?:\.\d+)+\s+)?(?:参考)?(?:答案与解析|答案|解答|习题答案)(?:\s*)$/u.test(text);
    if (numberedHeading) {
      const parts = numberedHeading[1].split('.');
      const parent = parts.length > 2 ? parts.slice(0, -1).join('.') : parts.join('.');
      if (parent !== section) { section = parent; group = ''; }
      sectionTitle = text;
      region = 'body'; type = '';
    }
    if (exercise) { region = 'question'; group = `${section || 'document'}:exercise:${++serial}`; type = ''; }
    if (answer) { region = 'answer'; type = ''; }
    const typeHeading = text.match(/^[一二三四五六七八九十]+[、．.]\s*(单项选择题|单选题|多项选择题|多选题|不定项选择题|综合应用题|简答题|计算题|判断题|填空题)/u);
    if (typeHeading) type = /单/.test(typeHeading[1]) ? 'single_choice' : /多|不定项/.test(typeHeading[1]) ? 'multiple_choice' : /判断/.test(typeHeading[1]) ? 'true_false' : /填空/.test(typeHeading[1]) ? 'fill_blank' : 'subjective';
    const boundary = Boolean(numberedHeading || exercise || answer || typeHeading || /^第\s*[\d一二三四五六七八九十]+\s*章|^参考文献/u.test(text));
    if (boundary && !numberedHeading && !exercise && !answer && !typeHeading) { region = 'body'; group = ''; type = ''; }
    if (!type && group && ['question', 'answer'].includes(region) && startPattern.test(text)) {
      if (optionsOf(text).length >= 2 || (region === 'answer' && /^\d+[.．、]\s*[A-F](?=\s|$)/u.test(text))) type = 'single_choice';
      else if (region === 'answer' && /【解答】/u.test(text)) type = 'subjective';
    }
    const path = [section, sectionTitle, typeHeading?.[1] || type].filter(Boolean);
    const block = { id: `block_${index}`, kind: item.type, text, rawText: text, pageNumber: number, bbox: item.bbox || null, imagePath: item.img_path || null, headingPath: path, section, group, region, questionType: type, boundary };
    page.blocks.push(block);
    page.headingPath = path;
    if (boundary) headings.push({ title: text, pageNumber: number, headingPath: path, level: item.text_level || 2 });
  }
  const result = [...pages.values()].sort((a,b) => a.number - b.number);
  for (const page of result) page.content = page.blocks.map(b => b.text).join('\n');
  return { format: 'mineru-content-list-v1', pages: result, headings, pageCount: Math.max(declaredPageCount, ...pages.keys()), pageNumbersKnown: true };
}

const startPattern = /^\s*(\d{1,3})[.．、]\s*(?!\d)([\s\S]*)$/u;
function splitBlocks(block) {
  // Some OCR blocks contain multiple answers; never split parenthesized subquestions.
  const parts = block.region === 'answer'
    ? block.text.split(/(?:\n|[ \t]+)(?=\s*\d{1,3}[.．、]\s*(?:[A-F](?=\s|$)|【解答】))/u)
    : block.text.split(/\n(?=\s*\d{1,3}[.．、]\s*(?!\d))/u);
  return parts.map(text => ({ ...block, text }));
}
const source = b => ({ blockId: b.id, page: b.pageNumber, bbox: b.bbox, imagePath: b.imagePath });
function optionsOf(text) {
  const result = [];
  for (const m of text.matchAll(/(?<![A-Za-z0-9])([A-F])[.．、)）]\s*([\s\S]*?)(?=(?<![A-Za-z0-9])[A-F][.．、)）]|$)/gu)) result.push({ marker: m[1], content: m[2].trim() });
  return result;
}
export function extractStructuredQuestions(document, bookId) {
  const questions = [], answers = [];
  let active = null;
  for (const block of document.pages.flatMap(p => p.blocks).flatMap(splitBlocks)) {
    if (block.boundary) { active = null; continue; }
    if (!block.group || !['question', 'answer'].includes(block.region) || !block.questionType) { active = null; continue; }
    const match = block.text.match(startPattern);
    if (match) {
      active = { number: String(Number(match[1])), group: block.group, type: block.questionType, section: block.section, blocks: [{ ...block, text: match[2] }] };
      (block.region === 'question' ? questions : answers).push(active);
    } else if (active) active.blocks.push(block);
  }
  const key = r => `${r.group}:${r.type}:${r.number}`;
  const answerMap = new Map(), questionCounts = new Map();
  for (const a of answers) answerMap.set(key(a), [...(answerMap.get(key(a)) || []), a]);
  for (const q of questions) questionCounts.set(key(q), (questionCounts.get(key(q)) || 0) + 1);
  return questions.map(q => {
    const raw = q.blocks.map(b => b.text || (b.imagePath ? `![题图](${b.imagePath})` : '')).join('\n').trim();
    const options = optionsOf(raw);
    const candidates = answerMap.get(key(q)) || [];
    const paired = candidates.length === 1 && questionCounts.get(key(q)) === 1 ? candidates[0] : null;
    const answerText = paired?.blocks.map(b => b.text).join('\n').trim() || '';
    const choice = answerText.match(/^([A-F]+)(?=\s|[。；;]|$)\s*([\s\S]*)/u);
    const isChoice = ['single_choice', 'multiple_choice'].includes(q.type);
    const correctAnswer = isChoice ? choice?.[1] || '' : answerText.replace(/^【解答】\s*/u, '');
    const explanation = isChoice ? choice?.[2] || '' : correctAnswer;
    const issues = [];
    if (candidates.length > 1 || questionCounts.get(key(q)) > 1) issues.push('练习组内题号重复，答案关联存在歧义');
    if (paired && isChoice && !choice) issues.push('答案格式复杂，需核验小问与答案');
    const questionId = id('question', `${bookId}:${key(q)}:${raw}`);
    return { questionId, bookId, sectionId: id('section', `${bookId}:${q.group}`), sectionTitle: q.section, sectionPath: [q.section, q.group, q.type], exerciseGroup: q.group,
      number: q.number, type: q.type, question: raw, stem: raw.split(/(?<![A-Za-z])A[.．、)）]/u)[0].trim(), options, optionMarkers: options.map(o=>o.marker),
      subquestions: [...raw.matchAll(/(?:^|\n)\s*(\d+)[)）]\s*([\s\S]*?)(?=\n\s*\d+[)）]|$)/gu)].map(m=>({ number: m[1], text: m[2] })),
      correctAnswer, officialExplanation: explanation, questionPage: q.blocks[0].pageNumber, answerPage: paired?.blocks[0].pageNumber ?? null, explanationPage: paired?.blocks[0].pageNumber ?? null,
      sourceQuote: raw, answerSourceQuote: answerText, status: correctAnswer ? 'auto_paired' : 'pending_review', issues, aiSuggestion: null, verificationHistory: [],
      matchEvidence: paired ? ['同一练习组', '同一题型', '题号唯一对应'] : [],
      origin: { questionLocator: `mineru:page:${q.blocks[0].pageNumber}`, questionBlocks: q.blocks.map(source), answerBlocks: paired?.blocks.map(source) || [] } };
  });
}
