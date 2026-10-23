const HAN = /\p{Script=Han}/u;

function tokens(text) {
  const words = String(text || '').normalize('NFKC').toLowerCase().match(/[a-z0-9]+|[\p{Script=Han}]+/gu) || [];
  return words.flatMap(word => {
    if (!HAN.test(word) || word.length < 2) return [word];
    const grams = Array.from({ length: word.length - 1 }, (_, index) => word.slice(index, index + 2));
    if (word.length <= 6) grams.push(word);
    return grams;
  });
}

function recordsForSource(source) {
  const pages = (source.pages || []).filter(page => typeof page.text === 'string' && page.text.trim());
  if (pages.length) return pages.map((page, index) => {
    const pageNumber = Number(page.number) || index + 1;
    const heading = (source.headings || []).filter(item => !item.pageNumber || item.pageNumber <= pageNumber).at(-1);
    return { sourceId: source.id, source: source.name, chunkId: `page-${pageNumber}`, pageNumber, headingPath: heading?.headingPath || [], text: page.text, recordIndex: index };
  });
  return (source.chunks || []).filter(chunk => typeof chunk.text === 'string' && chunk.text.trim()).map((chunk, index) => ({
    sourceId: source.id, source: source.name, chunkId: chunk.id ?? index,
    pageNumber: chunk.pageNumber || chunk.startPage || null,
    headingPath: Array.isArray(chunk.headingPath) ? chunk.headingPath : [],
    text: chunk.text, recordIndex: index,
  }));
}

function rankRecords(query, records) {
  const queryTokens = [...new Set(tokens(query))];
  if (!queryTokens.length) return [];
  const docs = records.map(record => {
    const ts = tokens(record.text), counts = new Map();
    for (const token of ts) counts.set(token, (counts.get(token) || 0) + 1);
    return { counts, length: ts.length };
  });
  const average = docs.reduce((sum, doc) => sum + doc.length, 0) / Math.max(1, docs.length);
  const dfs = new Map(queryTokens.map(token => [token, docs.filter(doc => doc.counts.has(token)).length]));
  const normalizedQuery = String(query).normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
  return records.map((record, index) => {
    const doc = docs[index]; let score = 0, matched = 0;
    for (const token of queryTokens) {
      const tf = doc.counts.get(token) || 0;
      if (!tf) continue;
      matched++;
      const df = dfs.get(token) || 0;
      const idf = Math.log(1 + (records.length - df + .5) / (df + .5));
      score += idf * (tf * 2.2) / (tf + 1.2 * (.25 + .75 * doc.length / Math.max(1, average)));
    }
    const normalizedText = record.text.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
    const exactPhrase = normalizedQuery.length >= 4 && normalizedText.includes(normalizedQuery);
    const latinTerms = [...new Set(String(query).match(/[a-z0-9]{4,}/giu) || [])].map(term => term.toLowerCase());
    const textLatin = new Set((record.text.match(/[a-z0-9]{4,}/giu) || []).map(term => term.toLowerCase()));
    const exactAnchors = latinTerms.filter(term => textLatin.has(term));
    return { ...record, score: score + (exactPhrase ? 100 : 0) + exactAnchors.length * 8, bm25: score, termCoverage: matched / queryTokens.length, exactPhrase, exactAnchors };
  }).filter(record => record.score > 0).sort((a, b) => b.score - a.score);
}

function compactText(text, start = 0, maxLength = 2200) {
  const value = String(text || '');
  if (value.length <= maxLength) return value;
  const from = Math.max(0, Math.min(value.length - maxLength, start - Math.floor(maxLength / 3)));
  return `${from ? '…' : ''}${value.slice(from, from + maxLength)}${from + maxLength < value.length ? '…' : ''}`;
}

function isAnswerHeading(line) {
  const value = String(line || '').trim().replace(/^#{1,6}\s*/u, '').replace(/^\*{1,2}|\*{1,2}$/gu, '').replace(/^[一二三四五六七八九十\d]+\s*[、.．]\s*/u, '').replace(/^[【\[(（]|[】\])）]$/gu, '');
  if (!value || value.length > 60) return false;
  return /^(?:(?:第\s*[\d一二三四五六七八九十]+\s*[章节篇部卷]\s*)?(?:本章|本节|课后|练习|习题|自测|参考|标准|选择题|填空题|判断题|解答题|部分|附录)*\s*(?:参考答案|答案(?:与解析|及解析|解析)?|参考解答|习题解答|练习解答|answer\s*key|answers?))(?:\s*[：:]?.*)?$/iu.test(value);
}

function answerMarkers(records) {
  return records.map((record, index) => {
    const lines = record.text.split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
    const headingLine = lines.find(isAnswerHeading) || record.headingPath?.find(isAnswerHeading) || '';
    return headingLine ? { index, heading: headingLine, record } : null;
  }).filter(Boolean);
}

function answerRegion(records) {
  const markers = answerMarkers(records);
  if (!markers.length) return { records, markers, scoped: false };
  const keep = new Set();
  let active = false;
  for (let index = 0; index < records.length; index++) {
    const record = records[index], lines = record.text.split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
    if (markers.some(marker => marker.index === index)) active = true;
    const nextMajorSection = lines.some(line => /^第\s*[\d一二三四五六七八九十百千万]+\s*[章节篇部卷](?=\s|$)/u.test(line) && !isAnswerHeading(line));
    if (active && nextMajorSection && !markers.some(marker => marker.index === index)) active = false;
    if (active) keep.add(index);
  }
  return { records: records.filter((_, index) => keep.has(index)), markers, scoped: true };
}

export function searchDocumentText({ sources, sourceIds, query, limit = 8 }) {
  const allowed = new Set(sourceIds || []);
  const records = (sources || []).filter(source => !allowed.size || allowed.has(source.id)).flatMap(recordsForSource);
  return rankRecords(query, records).slice(0, Math.max(1, Math.min(12, Number(limit) || 8))).map(record => ({
    ...record, text: compactText(record.text), kind: 'document-text',
  }));
}

export function findAnswerSections({ sources, sourceIds, sourceName }) {
  const allowed = new Set(sourceIds || []);
  const chosen = (sources || []).filter(source => (!allowed.size || allowed.has(source.id)) && (!sourceName || source.name.toLowerCase() === sourceName.trim().toLowerCase()));
  return chosen.flatMap(source => {
    const records = recordsForSource(source);
    return answerMarkers(records).map(({ record, heading }) => ({
      sourceId: source.id, source: source.name, pageNumber: record.pageNumber,
      chunkId: record.chunkId, headingPath: record.headingPath, heading,
      text: compactText(record.text, Math.max(0, record.text.indexOf(heading))), kind: 'answer-heading',
    }));
  }).slice(0, 20);
}

export function searchAnswerByNumber({ sources, sourceIds, sourceName, questionNumber, chapterHint = '', limit = 8 }) {
  const allowed = new Set(sourceIds || []), number = String(questionNumber || '').trim();
  if (!number) return [];
  const normalizedNumber = /^\d+$/u.test(number) ? number.replace(/^0+(?=\d)/u, '') : number;
  const escaped = normalizedNumber.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const entryPattern = new RegExp(`(?:^|[\\n\\r]|(?<=\\s))\\s*(?:第\\s*)?0*${escaped}(?:\\s*题)?\\s*[、.．:：)）]?\\s*(?=[A-HＡ-Ｈ对错√×答案解析（(（\\d一二三四五六七八九十])`, 'giu');
  const sourcesChosen = (sources || []).filter(source => (!allowed.size || allowed.has(source.id)) && (!sourceName || source.name.toLowerCase() === sourceName.trim().toLowerCase()));
  const hits = [];
  for (const source of sourcesChosen) {
    const all = recordsForSource(source), region = answerRegion(all), records = region.records;
    for (const record of records) {
      entryPattern.lastIndex = 0;
      const match = entryPattern.exec(record.text);
      if (!match) continue;
      const sectionTitle = region.markers.filter(marker => marker.index <= record.recordIndex).at(-1)?.heading || '';
      const chapterMatch = chapterHint && `${record.headingPath.join(' ')} ${sectionTitle}`.toLowerCase().includes(chapterHint.toLowerCase());
      hits.push({
        sourceId: source.id, source: source.name, pageNumber: record.pageNumber,
        chunkId: record.chunkId, headingPath: record.headingPath, kind: region.scoped ? 'answer' : 'unscoped-answer-candidate',
        answerSection: sectionTitle || null, scopedToAnswerSection: region.scoped,
        chapterMatch: Boolean(chapterMatch), text: compactText(record.text, match.index),
      });
    }
  }
  return hits.sort((a, b) => Number(b.scopedToAnswerSection) - Number(a.scopedToAnswerSection) || Number(b.chapterMatch) - Number(a.chapterMatch) || (a.pageNumber || 0) - (b.pageNumber || 0)).slice(0, Math.max(1, Math.min(12, Number(limit) || 8)));
}

export function readDocumentContext({ sources, sourceIds, sourceName, pageNumber, chunkId, before = 1, after = 1 }) {
  const allowed = new Set(sourceIds || []);
  const source = (sources || []).find(item => (!allowed.size || allowed.has(item.id)) && (!sourceName || item.name.toLowerCase() === sourceName.trim().toLowerCase()));
  if (!source) return [];
  const records = recordsForSource(source);
  let start = records.findIndex(record => chunkId != null && String(record.chunkId) === String(chunkId));
  if (start < 0 && Number.isInteger(Number(pageNumber))) start = records.findIndex(record => record.pageNumber === Number(pageNumber));
  if (start < 0) return [];
  const lo = Math.max(0, start - Math.min(3, Math.max(0, Number(before) || 0)));
  const hi = Math.min(records.length, start + Math.min(3, Math.max(0, Number(after) || 0)) + 1);
  return records.slice(lo, hi).map(record => ({ ...record, text: compactText(record.text, 0, 4500), kind: 'document-context' }));
}
