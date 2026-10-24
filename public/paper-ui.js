import { splitChoiceQuestion } from './question-presentation.js';
import { groupPaperQuestions, questionType, questionGroup, questionFigures, normalizeParts, questionIssues, needsQuestionReview } from './question-model.js';

const ordinals = ['一', '二', '三', '四', '五'];

export function paperQuestionMarkup(item, { esc, markdown, space = 'normal' }) {
  const choice = questionGroup(item) === '选择题' ? splitChoiceQuestion(item.question, questionType(item)) : null;
  const figures = questionFigures(item).map(figure => `<figure class="exam-figure"><img src="${esc(figure.src)}" alt="${esc(figure.caption || '题目附图')}">${figure.caption ? `<figcaption>${esc(figure.caption)}</figcaption>` : ''}</figure>`).join('');
  let options = '';
  if (choice) {
    const lengths = choice.options.map(option => option.content.replace(/\\[a-z]+/gu, '').length);
    const columns = lengths.every(length => length < 11) ? 4 : lengths.every(length => length < 28) ? 2 : 1;
    options = `<div class="exam-choice-options columns-${columns}">${choice.options.map(option => `<div class="exam-choice-option"><b>${esc(option.label)}.</b><div>${markdown(option.content)}</div></div>`).join('')}</div>`;
  }
  let answerArea = '';
  const group = questionGroup(item), factor = space === 'compact' ? .65 : space === 'roomy' ? 1.4 : 1;
  if (group === '判断题') answerArea = '<div class="exam-short-answer">答案：____________</div>';
  else if (group === '填空题') answerArea = '<div class="exam-fill-space"></div>';
  else if (group !== '选择题') {
    const parts = normalizeParts(item.parts);
    answerArea = parts.length ? parts.map(part => `<div class="exam-subquestion">${!item.question.includes(part.question) ? `<div>${markdown(part.question)}</div>` : ''}<div class="exam-workspace" style="height:${Math.round(34 * factor)}mm"><span>（${esc(part.number.replace(/[（）()]/gu, ''))}）</span></div></div>`).join('') : `<div class="exam-workspace" style="height:${Math.round(58 * factor)}mm"></div>`;
  }
  return `<article class="exam-question" data-paper-question="${esc(item.id)}"><div class="exam-question-prompt"><b class="exam-question-number">${item.paperNumber}.</b><div class="exam-question-stem">${markdown(choice ? choice.stem : item.question || item.title || '')}</div></div>${figures}${options}${answerArea}</article>`;
}

export function createPaperUI(h) {
  const e = h.esc, md = h.markdown;
  let pagination = Promise.resolve(), revision = 0;
  const ordered = () => groupPaperQuestions((h.state().paperDraft?.questionIds || []).map(id => h.state().mistakes.find(m => m.id === id)).filter(Boolean));
  function page() {
    const draft = h.state().paperDraft, sections = ordered(), items = sections.flatMap(section => section.items);
    if (!draft || !items.length) return `${h.heading('组卷预览', '请先从错题本选择题目。')}<button class="secondary-button" data-go="mistakes">返回错题本</button>`;
    const title = draft.title || '错题练习卷';
    const pending = items.filter(needsQuestionReview);
    const body = sections.map((section, index) => `<h2 class="exam-section-heading" data-keep-next>${ordinals[index]}、${section.group}<small>共 ${section.items.length} 题${section.group === '解答题' ? '；写出必要的解答过程' : ''}</small></h2>${section.items.map(item => paperQuestionMarkup(item, { esc: e, markdown: md, space: draft.answerSpace })).join('')}`).join('');
    const answers = draft.includeAnswers === false ? '' : `<header class="exam-answer-header" data-new-page><h1>参考答案与解析</h1><p>${e(title)}</p></header>${items.map(item => `<article class="exam-answer-item"><h3>${item.paperNumber}. <span>${e(questionType(item))}</span></h3><div class="exam-reference-answer">${md(item.correctAnswer || '暂未记录参考答案')}</div>${item.explanation ? `<div class="exam-explanation"><b>解析</b>${md(item.explanation)}</div>` : ''}</article>`).join('')}`;
    return `<section class="paper-builder exam-builder"><div class="paper-toolbar"><div class="paper-toolbar-top"><button class="secondary-button" data-go="mistakes">← 返回错题本</button><div><strong>试卷预览</strong><span>${items.length} 道题 · A4 · 按实际分页预览</span></div><button class="primary-button" id="print-paper">打印 / 保存 PDF</button></div><div class="paper-options"><label class="paper-title-field">试卷标题<input class="input" id="paper-title" maxlength="60" value="${e(title)}"></label><label class="paper-space-field">解答题留白<select class="select" id="paper-space"><option value="compact" ${draft.answerSpace === 'compact' ? 'selected' : ''}>紧凑</option><option value="normal" ${!draft.answerSpace || draft.answerSpace === 'normal' ? 'selected' : ''}>标准</option><option value="roomy" ${draft.answerSpace === 'roomy' ? 'selected' : ''}>宽松</option></select></label><label class="paper-answer-toggle"><input type="checkbox" id="paper-include-answers" ${draft.includeAnswers !== false ? 'checked' : ''}>答案与解析另页</label></div></div>${pending.length ? `<aside class="paper-review-notice" role="status"><strong>${pending.length} 道题待校对</strong><span>请检查缺失的条件、选项、附图或公式，避免打印不完整的题目。</span><div>${pending.map(item => `<button class="text-link" data-paper-edit="${e(item.id)}">第 ${item.paperNumber} 题：${e(questionIssues(item)[0])} →</button>`).join('')}</div></aside>` : ''}<div class="paper-pages" id="paper-pages" aria-label="试卷分页预览"></div><div class="paper-flow-source" id="paper-flow" aria-hidden="true"><header class="exam-document-header"><h1 class="exam-title">${e(title)}</h1></header>${body}${answers}</div></section>`;
  }
  function newPage(host, title) {
    const page = document.createElement('section'); page.className = 'exam-page' + (!host.children.length ? ' exam-first-page' : '');
    page.innerHTML = `<div class="exam-running-header">${e(title)}</div><div class="exam-page-body"></div><footer class="exam-page-footer"><span>${e(title)}</span><span class="exam-page-number"></span></footer>`;
    host.append(page); return page.querySelector('.exam-page-body');
  }
  async function paginate() {
    const ownRevision = ++revision, host = document.querySelector('#paper-pages'), flow = document.querySelector('#paper-flow');
    if (!host || !flow) return;
    await document.fonts?.ready;
    await Promise.all([...flow.querySelectorAll('img')].map(image => image.decode?.().catch(() => {})));
    if (ownRevision !== revision || !host.isConnected) return;
    host.innerHTML = '';
    const title = h.state().paperDraft.title || '错题练习卷';
    let body = newPage(host, title), keepNext = null;
    const fits = () => body.scrollHeight <= body.clientHeight + 1;
    function place(node) {
      body.append(node);
      if (fits()) return;
      if (body.children.length > 1) {
        node.remove();
        if (keepNext?.parentNode === body) keepNext.remove();
        body = newPage(host, title);
        if (keepNext) body.append(keepNext);
        body.append(node);
      }
      // An unusually long question can span pages. Split only at content blocks;
      // ordinary questions always keep their stem and options together.
      if (!fits() && node.children.length > 1) {
        const children = [...node.children]; node.innerHTML = '';
        for (const child of children) {
          node.append(child);
          if (!fits() && node.children.length > 1) {
            child.remove(); body = newPage(host, title);
            const continuation = document.createElement(node.tagName); continuation.className = node.className + ' exam-continuation';
            body.append(continuation); node = continuation; node.append(child);
          }
        }
      }
    }
    for (const original of [...flow.children]) {
      if (original.hasAttribute('data-new-page') && body.children.length) body = newPage(host, title);
      const node = original.cloneNode(true); place(node);
      keepNext = node.hasAttribute('data-keep-next') ? node : null;
    }
    const pages = [...host.querySelectorAll('.exam-page')];
    pages.forEach((page, index) => { page.querySelector('.exam-page-number').textContent = `第 ${index + 1} 页（共 ${pages.length} 页）`; });
    if (pages[0]) pages[0].classList.add('exam-first-page');
    host.style.setProperty('--paper-zoom', Math.min(1, Math.max(.3, (host.clientWidth - 4) / 794)));
  }
  function refresh() { h.render(); }
  async function print() {
    const pending = ordered().flatMap(section => section.items).filter(needsQuestionReview);
    if (pending.length) {
      h.modal.innerHTML = `<div class="modal-backdrop"><section class="modal intelligent-card" role="dialog" aria-modal="true" aria-labelledby="print-check-title"><h2 id="print-check-title">打印前检查题面</h2><p class="quiet-copy">以下 ${pending.length} 道题仍有待校对内容。</p><ul class="review-check-list">${pending.map(item => `<li><b>第 ${item.paperNumber} 题</b><span>${e(questionIssues(item).join('；'))}</span><button class="text-link" data-print-edit="${e(item.id)}">校对此题 →</button></li>`).join('')}</ul><div class="card-actions"><button class="secondary-button" id="print-check-close">返回检查</button><button class="primary-button" id="print-anyway">仍按当前题面打印</button></div></section></div>`;
      document.querySelector('#print-check-close').onclick = () => { h.modal.innerHTML = ''; };
      document.querySelector('#print-anyway').onclick = () => { h.modal.innerHTML = ''; void doPrint(); };
      h.modal.querySelectorAll('[data-print-edit]').forEach(button => { button.onclick = () => h.edit(button.dataset.printEdit); });
      document.querySelector('#print-check-close').focus(); return;
    }
    await doPrint();
  }
  async function doPrint() {
    const button = document.querySelector('#print-paper'), previousTitle = document.title;
    if (button) button.disabled = true;
    try {
      await h.save(); pagination = paginate(); await pagination;
      document.title = h.state().paperDraft.title || '错题练习卷'; window.print();
    } catch (error) { h.notify('打印准备失败：' + error.message); }
    finally { document.title = previousTitle; if (button) button.disabled = false; }
  }
  function bind() {
    const title = document.querySelector('#paper-title'); if (!title) return;
    title.oninput = () => {
      h.state().paperDraft.title = title.value.trim() || '错题练习卷';
      document.querySelector('#paper-flow .exam-title').textContent = h.state().paperDraft.title;
      pagination = paginate();
    };
    title.onchange = () => h.save().catch(error => h.notify('标题保存失败：' + error.message));
    document.querySelector('#paper-include-answers').onchange = async event => { h.state().paperDraft.includeAnswers = event.target.checked; await h.save(); refresh(); };
    document.querySelector('#paper-space').onchange = async event => { h.state().paperDraft.answerSpace = event.target.value; await h.save(); refresh(); };
    document.querySelectorAll('[data-paper-edit]').forEach(button => { button.onclick = () => h.edit(button.dataset.paperEdit); });
    document.querySelector('#print-paper').onclick = () => { void print(); };
    pagination = paginate();
  }
  return { page, bind, paginate };
}
