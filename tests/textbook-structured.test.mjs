import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStructuredDocument } from '../textbook-structured.mjs';
import { extractQuestionRecords, validateQuestionRecords, isQuestionPublishable } from '../textbook-pipeline.mjs';
const b = (text, page_idx = 0, extra = {}) => ({ text, page_idx, type: 'text', bbox: [0,0,100,100], ...extra });
const extract = items => validateQuestionRecords(extractQuestionRecords(buildStructuredDocument(items), 'test'));
test('scopes repeated numbers to section and type; excludes lecture and keeps cross-page explanation', () => {
 const q = extract([
 b('3.1 内存'), b('1. 为什么管理内存？'), b('3.1.7 本节习题精选'), b('一、单项选择题'),
 b('01. 正确的是（）。A. 甲 B. 乙'), b('二、综合应用题'), b('01. 计算容量。'), b('1）第一问\n补充条件'), b('2）第二问'),
 b('3.1.8 答案与解析'), b('一、单项选择题'), b('01. B',1), b('解释开头',1), b('页眉',2,{type:'header'}), b('解释结尾',2),
 b('二、综合应用题',2), b('01.【解答】',2), b('1）答案一\n2）答案二',2),
 b('3.2 虚拟内存',3), b('3.2.11 本节习题精选',3), b('一、单项选择题',3), b('01. 另一题 A. 是 B. 否',3),
 b('3.2.12 答案与解析',4), b('一、单项选择题',4), b('01. A',4)
 ]);
 assert.equal(q.length,3); assert.deepEqual(q.map(x=>x.correctAnswer),['B','1）答案一\n2）答案二','A']);
 assert.equal(q[0].options.length,2); assert.equal(q[0].stem,'正确的是（）。');
 assert.equal(q[0].officialExplanation,'解释开头\n解释结尾'); assert.equal(q[0].origin.answerBlocks.at(-1).page,3);
 assert.equal(q[1].subquestions.length,2); assert.match(q[1].subquestions[0].text,/补充条件/);
 assert.equal(isQuestionPublishable(q[0]),false);
});
test('duplicates and compound answers are not guessed; inline answer rows split',()=>{
 const q=extract([b('3.1.7 本节习题精选'),b('一、单项选择题'),b('01. 问题 A. 是 B. 否'),b('02. 问题二 A. 是 B. 否'),b('03. 问题三 A. 是 B. 否'),b('3.1.8 答案与解析'),b('一、单项选择题'),b('01. A 02. B'),b('01. B'),b('03. ①B、②A')]);
 assert.equal(q[0].correctAnswer,'');assert.equal(q[1].correctAnswer,'B');assert.equal(q[2].correctAnswer,'');assert.match(q[2].answerSourceQuote,/①B/);
});
test('physical and printed pages remain separate, and unscoped question-like text is ignored',()=>{
 const d=buildStructuredDocument([b('190',14,{type:'page_number'}),b('1. 下列说法正确的是？ A. 是 B. 否',14)]);
 assert.equal(d.pages[0].number,15);assert.equal(d.pages[0].printedPage,'190');assert.equal(extractQuestionRecords(d,'test').length,0);
});
test('OCR options without intervening whitespace remain separate',()=>{
 const q=extract([b('4.2.11 本节习题精选'),b('一、单项选择题'),b('01. 哪个正确？A.甲B.乙C.丙D.丁'),b('4.2.12 答案与解析'),b('一、单项选择题'),b('01. C')]);
 assert.deepEqual(q[0].options.map(x=>x.content),['甲','乙','丙','丁']);assert.equal(q[0].issues.length,0);
});
