const CHUNK_LIMIT = 1100;
const CHUNK_OVERLAP = 140;

function stripPageMarker(line) {
  return line
    .replace(/^\s*\[?第\s*\d+\s*页\]?\s*$/u, '')
    .replace(/^\s*<!--\s*pagebreak\s*-->\s*$/iu, '')
    .trim();
}

function cleanTocLeader(line) {
  return line
    .replace(/(?:\.{2,}|…{2,}|·{2,}|\s{2,})\s*(?:第\s*)?\d{1,4}\s*(?:页)?\s*$/u, '')
    .trim();
}

export function detectDocumentHeading(rawLine) {
  const line = stripPageMarker(rawLine);
  if (!line || line.length > 140 || /^目录$/u.test(line)) return null;
  const content = cleanTocLeader(line);
  const markdown = content.match(/^\s*(#{1,6})\s+(.+?)\s*#*\s*$/u);
  if (markdown) return { level: markdown[1].length, title: markdown[2].trim() };

  const chapter = content.match(/^\s*第\s*([〇零一二三四五六七八九十百千万\d]+)\s*([章节篇部卷])\s*[：:、.．\s-]*\s*(.{0,100})$/u);
  if (chapter) {
    const level = chapter[2] === '章' || chapter[2] === '篇' || chapter[2] === '部' || chapter[2] === '卷' ? 1 : 2;
    return { level, title: `${chapter[0].trim()}` };
  }

  const numbered = content.match(/^\s*(\d+(?:\.\d+){0,4})[、.．\s]+(.{2,100})$/u);
  if (numbered && numbered[1].includes('.')) {
    return { level: Math.min(6, numbered[1].split('.').length + 1), title: content.trim() };
  }
  return null;
}

function looksLikeTocEntry(rawLine) {
  const line = rawLine.trim();
  if (!line || line.length > 150) return false;
  const hasPageReference = /(?:\.{2,}|…{2,}|·{2,}|\s{2,})\s*(?:第\s*)?\d{1,4}\s*(?:页)?\s*$/u.test(line);
  return hasPageReference && Boolean(detectDocumentHeading(line));
}

function tocPageSet(pages) {
  const marked = new Set();
  const entries = pages.map(page => {
    const lines = String(page.text || '').split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
    const tocTitle = lines.some(line => /^目\s*录$/u.test(line) || /^contents$/iu.test(line));
    const tocRows = lines.filter(looksLikeTocEntry).length;
    return { pageNumber: page.pageNumber, tocTitle, tocRows };
  });
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (entry.tocTitle) {
      marked.add(entry.pageNumber);
      for (let next = index + 1; next < Math.min(entries.length, index + 4); next++) {
        if (entries[next].tocRows >= 2) marked.add(entries[next].pageNumber);
        else if (next > index + 1) break;
      }
      continue;
    }
    const isNearFront = index < Math.max(8, Math.ceil(entries.length * 0.3));
    if (Number.isInteger(entry.pageNumber) && isNearFront && entry.tocRows >= 3) marked.add(entry.pageNumber);
  }
  return marked;
}

function splitMarkdownPages(markdown) {
  const pages = [];
  let current = [];
  let nextPage = 1;
  let pageNumber = null;
  const flush = () => {
    const text = current.join('\n').trim();
    if (text) pages.push({ pageNumber, text });
    current = [];
  };
  for (const rawLine of String(markdown || '').replace(/\r/g, '').split('\n')) {
    const line = rawLine.trim();
    const explicit = line.match(/^\s*(?:<!--\s*page\s*:?[\s-]*(\d+)\s*-->|\[?第\s*(\d+)\s*页\]?|page\s+(\d+)\s*)$/iu);
    if (/^\s*<!--\s*pagebreak\s*-->\s*$/iu.test(line)) {
      const hasContent = current.some(item => item.trim());
      if (!pages.length && !hasContent) { pageNumber = nextPage++; continue; }
      if (pageNumber === null) pageNumber = nextPage++;
      flush();
      pageNumber = nextPage++;
      continue;
    }
    if (explicit) {
      flush();
      pageNumber = Number(explicit[1] || explicit[2] || explicit[3]);
      nextPage = Math.max(nextPage, pageNumber + 1);
      continue;
    }
    current.push(rawLine);
  }
  flush();
  return pages.length ? pages : [{ pageNumber: null, text: String(markdown || '').trim() }];
}

function makeChunkText(body, pageNumber, headingPath) {
  const context = [
    pageNumber ? `[第 ${pageNumber} 页]` : '',
    headingPath.length ? `[章节路径：${headingPath.join(' > ')}]` : '',
  ].filter(Boolean).join('\n');
  return `${context ? `${context}\n` : ''}${body}`.trim();
}

function splitLongLine(line, limit, overlap) {
  const parts = [];
  let start = 0;
  while (start < line.length) {
    const end = Math.min(line.length, start + limit);
    parts.push(line.slice(start, end));
    if (end === line.length) break;
    start = Math.max(start + 1, end - overlap);
  }
  return parts;
}

function buildChunks(pages, { idPrefix = 'p', maxChars = CHUNK_LIMIT, overlap = CHUNK_OVERLAP } = {}) {
  const tocPages = tocPageSet(pages);
  const chunks = [];
  const headings = [];
  const headingStack = [];
  const seenHeadings = new Set();

  pages.forEach((page, pageIndex) => {
    const pageNumber = Number.isInteger(page.pageNumber) ? page.pageNumber : null;
    const lines = String(page.text || '').replace(/\r/g, '').split(/\n+/u).map(stripPageMarker).filter(Boolean);
    let current = '';
    let currentPath = [...headingStack];
    let part = 0;
    const flush = () => {
      const body = current.trim();
      if (!body) return;
      const headingPath = currentPath.filter(Boolean);
      chunks.push({
        id: `${idPrefix}${pageNumber || pageIndex + 1}-${part++}`,
        pageNumber,
        startPage: pageNumber,
        endPage: pageNumber,
        headingPath,
        kind: tocPages.has(pageNumber) ? 'toc' : 'content',
        text: makeChunkText(body, pageNumber, headingPath),
      });
      current = '';
      currentPath = [...headingStack];
    };
    const append = raw => {
      const pieces = raw.length > maxChars ? splitLongLine(raw, maxChars, overlap) : [raw];
      for (const piece of pieces) {
        if (current && current.length + piece.length + 1 > maxChars) {
          const previous = current.slice(-overlap);
          flush();
          current = previous;
          currentPath = [...headingStack];
        }
        current += `${current ? '\n' : ''}${piece}`;
      }
    };

    for (const line of lines) {
      const heading = detectDocumentHeading(line);
      if (heading) {
        while (headingStack.length >= heading.level) headingStack.pop();
        headingStack[heading.level - 1] = heading.title;
        headingStack.length = heading.level;
        const path = headingStack.filter(Boolean);
        const record = { level: heading.level, title: heading.title, headingPath: path, pageNumber, kind: tocPages.has(pageNumber) ? 'toc' : 'heading' };
        const key = `${pageNumber || ''}:${record.headingPath.join('>')}`;
        if (!seenHeadings.has(key)) { headings.push(record); seenHeadings.add(key); }
        if (current && current.length + line.length + 1 > maxChars) flush();
        if (!current) currentPath = [...path];
      }
      append(line);
    }
    flush();
  });

  return { chunks, headings, tocPages: [...tocPages].filter(Number.isInteger).sort((a, b) => a - b) };
}

export function splitStructuredText(text, { pageNumber = null, idPrefix = 'c' } = {}) {
  return buildChunks([{ pageNumber, text: String(text || '') }], { idPrefix }).chunks;
}

export function buildPageChunks(pages) {
  return buildChunks(pages.map((text, index) => ({ pageNumber: index + 1, text: String(text || '') })), { idPrefix: 'p' });
}

export function buildMarkdownChunks(markdown, pageCount = 0) {
  const pages = splitMarkdownPages(markdown);
  const result = buildChunks(pages, { idPrefix: 'm' });
  return { ...result, pageCount: Math.max(Number(pageCount) || 0, ...pages.map(page => page.pageNumber || 0)) };
}

export function isDocumentWideQuery(question) {
  return /目录|章(?:节|标题|结构)|有哪些章节|有几章|多少章|各章|全书|整本书|这本书.*(?:结构|内容|讲什么)|大纲|内容框架|章节安排|table of contents|book outline|chapter list/iu.test(String(question || ''));
}

export function outlineFromSource(source) {
  const saved = Array.isArray(source?.headings) ? source.headings : [];
  let records = saved.filter(item => item && typeof item.title === 'string' && item.title.trim());
  if (!records.length) {
    const pages = Array.isArray(source?.pages) && source.pages.some(page => page?.text)
      ? source.pages.map((page, index) => ({ pageNumber: page.number || index + 1, text: page.text || '' }))
      : (source?.chunks || []).map(chunk => {
        const match = String(chunk.text || '').match(/^\[第\s*(\d+)\s*页\]/u);
        return { pageNumber: chunk.pageNumber || (match ? Number(match[1]) : null), text: chunk.text || '' };
      });
    records = buildChunks(pages, { idPrefix: 'outline' }).headings;
  }
  const unique = new Map();
  for (const item of records) {
    const title = String(item.title || '').trim();
    const path = Array.isArray(item.headingPath) && item.headingPath.length ? item.headingPath : [title];
    const pageNumber = Number.isInteger(item.pageNumber) ? item.pageNumber : null;
    const key = `${path.join('>')}:${pageNumber || ''}`;
    if (title && !unique.has(key)) unique.set(key, { title, level: Number(item.level) || path.length, headingPath: path, pageNumber, kind: item.kind || 'heading' });
  }
  return [...unique.values()].sort((a, b) => (a.pageNumber || Number.MAX_SAFE_INTEGER) - (b.pageNumber || Number.MAX_SAFE_INTEGER) || a.level - b.level).slice(0, 180);
}
