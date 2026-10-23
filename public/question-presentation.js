// Split a clear option sequence for presentation only. Stored questions stay untouched.
function protectedRanges(source) {
  const ranges = [];
  const protect = pattern => { for (const match of source.matchAll(pattern)) ranges.push([match.index, match.index + match[0].length]); };
  const lines = [...source.matchAll(/^.*$/gm)];
  let fence = null;
  for (const line of lines) {
    if (!fence) { const match = line[0].match(/^ {0,3}(`{3,}|~{3,})/u); if (match) fence = {start:line.index, char:match[1][0], length:match[1].length}; }
    else if (new RegExp(`^ {0,3}${fence.char}{${fence.length},}[ \\t]*$`, 'u').test(line[0])) { ranges.push([fence.start, line.index + line[0].length]); fence = null; }
  }
  if (fence) ranges.push([fence.start, source.length]);
  protect(/(`+)[^\n]*?\1(?!`)/gu);
  protect(/\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]|(?<!\\)\$\$[\s\S]*?(?<!\\)\$\$|(?<!\\)\$(?!\$)(?:\\.|[^$])*?(?<!\\)\$/gu);
  protect(/!?\[[^\]\n]*\]\((?:\\.|[^)\n])*\)|<[^>\n]+>/gu);
  for (let i = 0; i < lines.length - 1; i++) {
    const divider = lines[i + 1][0];
    if (!lines[i][0].includes('|') || !divider.includes('|') || !/-{3,}/u.test(divider) || !/^\s*\|?[\s:|\-]+\|?\s*$/u.test(divider)) continue;
    let end = i + 2;
    while (end < lines.length && lines[end][0].includes('|') && lines[end][0].trim()) end++;
    ranges.push([lines[i].index, end < lines.length ? lines[end].index : source.length]); i = end - 1;
  }
  return ranges;
}

export function splitChoiceQuestion(value, type = '') {
  const source = String(value ?? '');
  const explicitChoice = /(?:选择|单选|多选|不定项)/u.test(String(type));
  const ranges = protectedRanges(source);
  const protectedAt = (start, end) => ranges.some(([from, to]) => start < to && end > from);
  const candidates = [];
  const markers = /[（(][ \t\u00a0\u3000]*([A-HＡ-Ｈ])[ \t\u00a0\u3000]*[）)]|([A-HＡ-Ｈ])[ \t\u00a0\u3000]*[.．、:：,，)）]/gu;
  for (const match of source.matchAll(markers)) {
    let start = match.index, end = start + match[0].length;
    if (protectedAt(start, end) || /[A-Za-zＡ-Ｚａ-ｚ_\\/]/u.test(source[start - 1] || '')) continue;
    // A Markdown emphasis wrapper belongs to the option label, not its contents.
    const wrapper = source.slice(Math.max(0, start - 2), start);
    if (wrapper === '**' || wrapper === '__') {
      if (source.slice(end, end + 2) !== wrapper) continue;
      start -= 2; end += 2;
    }
    const lineStart = source.lastIndexOf('\n', start - 1) + 1;
    if (/^[ \t]*(?:[-*+]\s+)?$/u.test(source.slice(lineStart, start))) start = lineStart;
    candidates.push({ start, end, label: (match[1] || match[2]).normalize('NFKC'), marker: match[0].trim() });
  }
  // Some OCR output keeps the letters but drops their punctuation entirely.
  if (explicitChoice && !candidates.some(candidate => candidate.label === 'A')) {
    for (const match of source.matchAll(/(?:^|[\s　:：;；?？)）])([A-HＡ-Ｈ])(?=[ \t\u00a0\u3000]+)/gu)) {
      const start = match.index + match[0].length - 1, end = start + 1;
      if (!protectedAt(start, end)) candidates.push({start, end, label:match[1].normalize('NFKC'), marker:match[1], bare:true});
    }
    candidates.sort((a,b)=>a.start-b.start);
  }
  const groups = [];
  for (let i = 0; i < candidates.length; i++) {
    if (candidates[i].label !== 'A') continue;
    const group = [candidates[i]];
    let ambiguous = false;
    for (let j = i + 1; j < candidates.length; j++) {
      const next = candidates[j], previous = group.at(-1);
      if (next.label === 'A') break;
      if (next.label <= previous.label || !explicitChoice && next.label.charCodeAt(0) !== previous.label.charCodeAt(0) + 1) { ambiguous = true; break; }
      group.push(next);
    }
    if (ambiguous || group.length < (explicitChoice && !group[0].bare ? 2 : 3)) continue;
    const stem = source.slice(0, group[0].start).trim();
    if (type && !explicitChoice && !/(?:选项|选择|下列[\s\S]*(?:正确|错误|符合|成立))/u.test(stem)) continue;
    const options = group.map((marker, index) => ({
      label: marker.label, marker: marker.marker,
      content: source.slice(marker.end, group[index + 1]?.start ?? source.length).trim(),
    }));
    if (options.some(option => !option.content)) continue;
    groups.push({ stem, options });
  }
  // Multiple question/option groups and ambiguous prose keep their original Markdown.
  return groups.length === 1 ? groups[0] : null;
}
