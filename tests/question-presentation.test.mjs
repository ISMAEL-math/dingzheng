import test from 'node:test';
import assert from 'node:assert/strict';
import { splitChoiceQuestion } from '../public/question-presentation.js';

test('inline choices become separate display items without rewriting their text',()=>{
  const source='下列说法正确的是：A. 甲成立B. 乙成立C. 丙成立D. 丁成立';
  const result=splitChoiceQuestion(source,'单选题');
  assert.equal(result.stem,'下列说法正确的是：');
  assert.deepEqual(result.options.map(option=>option.content),['甲成立','乙成立','丙成立','丁成立']);
  assert.deepEqual(result.options.map(option=>option.marker),['A.','B.','C.','D.']);
  assert.equal(source,'下列说法正确的是：A. 甲成立B. 乙成立C. 丙成立D. 丁成立');
});
test('single newlines and existing paragraph breaks use the same option structure',()=>{
  for(const separator of [' ','\n','\n\n']){
    const result=splitChoiceQuestion(['请选择：','A. 一','B. 二','C. 三','D. 四'].join(separator),'选择题');
    assert.deepEqual(result.options.map(option=>option.content),['一','二','三','四']);
  }
});
test('parenthesized, full-width and mixed punctuation labels are kept',()=>{
  const result=splitChoiceQuestion('请选择：（Ａ）甲 （Ｂ）乙 （Ｃ）丙 （Ｄ）丁','多选题');
  assert.deepEqual(result.options.map(option=>option.label),['A','B','C','D']);assert.equal(result.options[0].marker,'（Ａ）');
  assert.deepEqual(splitChoiceQuestion('题目 A、甲 B．乙 C：丙 D）丁','单选题').options.map(option=>option.content),['甲','乙','丙','丁']);
});
test('labels in inline or display mathematics are not treated as option boundaries',()=>{
  const first='$P(A. B. C. D.)=1$';
  const question=`求概率，选择正确项：A. ${first} B. \\(\\text{A. B. C. D.}\\) C. $$\\text{A. B. C. D.}$$ D. \\[\\text{A. B. C. D.}\\]`;
  const result=splitChoiceQuestion(question,'单选题');assert.equal(result.options.length,4);assert.equal(result.options[0].content,first);
  assert.equal(result.options[1].content,'\\(\\text{A. B. C. D.}\\)');assert.equal(result.options[3].content,'\\[\\text{A. B. C. D.}\\]');
});
test('code, including a longer closing fence or an unclosed fence, keeps its original structure',()=>{
  for(const code of ['```js\nA. a B. b C. c D. d\n````','~~~\nA. a B. b C. c D. d','`A. a B. b C. c D. d`'])assert.equal(splitChoiceQuestion(code,'单选题'),null);
  const source='请选择：A. 代码如下\n```js\nconst value = "B. C. D.";\n```\nB. 另一个选项 C. 第三个选项 D. 最后一个选项';
  const result=splitChoiceQuestion(source,'单选题');assert.equal(result.options.length,4);assert.match(result.options[0].content,/const value = "B. C. D."/);
});
test('a Markdown table of choices remains a table',()=>{
  const table='| A. 甲 | B. 乙 | C. 丙 | D. 丁 |\n| --- | --- | --- | --- |\n| 1 | 2 | 3 | 4 |';
  assert.equal(splitChoiceQuestion('根据表格选择：\n'+table,'单选题'),null);
});
test('images and links cannot introduce false option markers',()=>{
  const source='请选择：![A. B. C. D.](diagram.png) A. [查看 A. B. C. D.](https://example.com) B. 第二项 C. 第三项 D. 第四项';
  const result=splitChoiceQuestion(source,'单选题');assert.equal(result.options.length,4);assert.match(result.stem,/!\[A\. B\. C\. D\.\]/);assert.equal(result.options[0].content,'[查看 A. B. C. D.](https://example.com)');
});
test('Markdown bullets and bold labels do not leave stray formatting in the stem',()=>{
  const result=splitChoiceQuestion('选择正确项：\n- **A.** 甲\n- **B.** 乙\n- **C.** 丙\n- **D.** 丁','单选题');
  assert.equal(result.stem,'选择正确项：');assert.deepEqual(result.options.map(option=>option.content),['甲','乙','丙','丁']);
});
test('long multiline option contents are preserved for wrapping by the existing Markdown renderer',()=>{
  const text='这是一段较长的选项，其条件、单位和补充说明应保持原样。\n\n- 条件一\n- 条件二';
  const result=splitChoiceQuestion(`下列说法正确的是： A. ${text}\nB. 第二项 C. 第三项 D. 第四项`,'多选题');assert.equal(result.options[0].content,text);
});
test('missing option labels are not invented and ambiguous or non-choice text is left alone',()=>{
  assert.deepEqual(splitChoiceQuestion('下列选项正确的是：A. 甲 C. 丙 D. 丁','单选题').options.map(option=>option.label),['A','C','D']);
  assert.equal(splitChoiceQuestion('A、B、C、D为四个不同点，求面积。','计算题'),null);
  assert.equal(splitChoiceQuestion('分情况讨论：A. 正数 B. 负数 C. 零','解答题'),null);
  assert.equal(splitChoiceQuestion('只有一项：A. 甲','单选题'),null);
  assert.equal(splitChoiceQuestion('A. 甲 B. 乙 C. 丙 D. 丁\n\nA. 子 B. 丑 C. 寅 D. 卯','单选题'),null);
});
test('choice formatting also works for older questions without a stored type',()=>{
  assert.equal(splitChoiceQuestion('下列说法正确的是 A. 甲 B. 乙 C. 丙 D. 丁').options.length,4);
  assert.equal(splitChoiceQuestion('第一段 A. 第二段 B. 最后一段'),null);
});
test('OCR options without punctuation can still be laid out for a known choice question',()=>{
  const result=splitChoiceQuestion('请选择正确方向：A 向左 B 向右 C 向上 D 向下','单选题');
  assert.deepEqual(result.options.map(option=>option.content),['向左','向右','向上','向下']);
  assert.equal(splitChoiceQuestion('设矩阵 A 与矩阵 B 的关系如图','单选题'),null);
});
