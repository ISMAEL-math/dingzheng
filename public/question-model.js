import { splitChoiceQuestion } from './question-presentation.js';

export const QUESTION_TYPES = ['单选题', '多选题', '填空题', '判断题', '解答题', '待分类'];
export const QUESTION_GROUPS = ['选择题', '填空题', '判断题', '解答题', '待分类'];

export function questionType(item = {}) {
  const type = String(item.type || '').trim();
  if (QUESTION_TYPES.includes(type)) return type;
  if (/多选|不定项/u.test(type)) return '多选题';
  if (/选择|单选/u.test(type)) return '单选题';
  if (/填空/u.test(type)) return '填空题';
  if (/判断|正误/u.test(type)) return '判断题';
  if (/解答|计算|简答|证明|综合|论述|应用|作图|大题/u.test(type)) return '解答题';
  if (splitChoiceQuestion(item.question || '')) return /多选|不定项/u.test(item.question) ? '多选题' : '单选题';
  return '待分类';
}

export function questionGroup(item) {
  const type = questionType(item);
  return type === '单选题' || type === '多选题' ? '选择题' : type;
}

export function questionFigures(item = {}) {
  return (Array.isArray(item.figures) ? item.figures : [])
    .filter(figure => figure && typeof figure.src === 'string' && /^data:image\/(?:jpeg|png|webp|gif);base64,[a-z\d+/=\s]+$/iu.test(figure.src))
    .slice(0, 12).map(figure => ({ src: figure.src, caption: String(figure.caption || '').slice(0, 160) }));
}

export function normalizeParts(parts) {
  return (Array.isArray(parts) ? parts : []).filter(part => part && typeof part.question === 'string' && part.question.trim())
    .slice(0, 30).map((part, index) => ({
      number: String(part.number || index + 1).slice(0, 20), question: part.question.trim(),
      ...(Number.isFinite(part.maxScore) && part.maxScore > 0 ? { maxScore: part.maxScore } : {})
    }));
}

export function questionSignature(item) {
  const text = JSON.stringify([item.question || '', questionType(item), questionFigures(item), normalizeParts(item.parts)]);
  let first = 2166136261, second = 5381;
  for (let i = 0; i < text.length; i++) { first = Math.imul(first ^ text.charCodeAt(i), 16777619); second = Math.imul(second, 33) ^ text.charCodeAt(i); }
  return `${(first >>> 0).toString(16)}-${(second >>> 0).toString(16)}-${text.length}`;
}

// These are checks for visible omissions, not a claim that the question is mathematically correct.
export function questionIssues(item) {
  const text = String(item.question || '').trim(), issues = [];
  if (!text) issues.push('题干为空');
  if (/\[(?:无法辨认|无法识别|看不清|缺失|待补充)[^\]]*\]|【(?:无法辨认|缺失)[^】]*】|�/u.test(text)) issues.push('题面含无法辨认或缺失内容');
  if (/[，,:：、（(]$/u.test(text)) issues.push('题干可能尚未结束');
  const type = questionType(item);
  if (type === '待分类') issues.push('题型尚未确认');
  if (questionGroup(item) === '选择题') {
    const choice = splitChoiceQuestion(text, type);
    if (!choice) issues.push('选择题的选项未完整识别');
    else {
      const labels = choice.options.map(option => option.label);
      if (labels.some((label, index) => label !== String.fromCharCode(65 + index))) issues.push('选项编号不连续，请检查是否漏项');
      if (labels.length < 4) issues.push('选项少于四项，请核对原题');
    }
  }
  const count = pattern => [...text.matchAll(pattern)].length;
  const mathText = text.replace(/```[\s\S]*?```|`[^`\n]*`/gu, '');
  if (count(/\\\(/gu) !== count(/\\\)/gu) || count(/\\\[/gu) !== count(/\\\]/gu)
      || [...mathText.matchAll(/(?<!\\)\$\$/gu)].length % 2
      || [...mathText.replace(/(?<!\\)\$\$/gu, '').matchAll(/(?<!\\)\$/gu)].length % 2) issues.push('公式分隔符不完整');
  const mathBlocks = [...text.matchAll(/\\\(([\s\S]*?)\\\)|\\\[([\s\S]*?)\\\]|\$\$([\s\S]*?)\$\$|(?<!\\)\$([^$\n]+)\$/gu)];
  if (mathBlocks.some(match => {
    const formula = match.slice(1).find(value => value !== undefined) || '';
    return [...formula.matchAll(/(?<!\\)\{/gu)].length !== [...formula.matchAll(/(?<!\\)\}/gu)].length;
  })) issues.push('公式括号可能缺失');
  if (/(?:如图|下图|图中|见图|图\s*[一二三四五六七八九十\d]+\s*所示)/u.test(text)
      && !questionFigures(item).length && !/!\[[^\]]*\]\([^)]+\)/u.test(text)) issues.push('题目引用了附图，请补充必要附图');
  return [...new Set(issues)];
}

export function needsQuestionReview(item) {
  return questionIssues(item).length > 0 && item.reviewedSignature !== questionSignature(item);
}

export function groupPaperQuestions(items) {
  let number = 0;
  return QUESTION_GROUPS.map(group => ({ group, items: items.filter(item => questionGroup(item) === group) }))
    .filter(section => section.items.length).map(section => ({
      ...section, items: section.items.map(item => ({ ...item, paperNumber: ++number }))
    }));
}
