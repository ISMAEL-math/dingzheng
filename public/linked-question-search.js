const normalize = value => String(value || '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
// Full stem and option values are required. A number or topical similarity is not identity.
export function linkedQuestionEvidence(sources, sourceIds, query) {
  const normalized = normalize(query), matches = [];
  for (const source of sources.filter(s => sourceIds.includes(s.id))) {
    for (const q of source.questionRecords || []) {
      if (q.status === 'rejected') continue;
      const stem = normalize(q.stem);
      if (stem.length < 12 || !normalized.includes(stem)) continue;
      if ((q.options || []).some(option => !normalized.includes(normalize(`${option.marker}${option.content}`)))) continue;
      matches.push({ source, q });
    }
  }
  if (matches.length !== 1) return [];
  const { source, q } = matches[0];
  const verified = q.status === 'verified' && !(q.issues || []).length;
  return [{ source: source.name, sourceId: source.id, chunkId: `question:${q.questionId}`, pageNumber: q.questionPage,
    headingPath: q.sectionPath, kind: 'linked_question', questionId: q.questionId, answerVerified: verified,
    text: `完整题目：\n${q.question}\n\n关联状态：${verified ? '已人工核验' : '自动关联候选，尚未人工核验'}\n关联依据：${(q.matchEvidence || []).join('、')}\n题目 PDF 页：${q.questionPage}\n答案 PDF 页：${q.answerPage ?? '未知'}\n教材候选答案：${q.correctAnswer || '未可靠关联'}\n教材解析原文：${q.officialExplanation || '未提取'}\n待处理问题：${(q.issues || []).join('；') || '无自动检测问题（不等于人工核验）'}` }];
}
