import test from 'node:test';
import assert from 'node:assert/strict';
import { linkedQuestionEvidence } from '../public/linked-question-search.js';
const q={questionId:'fat32',stem:'FAT32 的文件目录项不包括（）。',question:'FAT32 的文件目录项不包括（）。 A. 文件名 B. 文件访问权限说明 C. 文件控制块的物理位置 D. 文件所在的物理位置',options:[{marker:'A',content:'文件名'},{marker:'B',content:'文件访问权限说明'},{marker:'C',content:'文件控制块的物理位置'},{marker:'D',content:'文件所在的物理位置'}],correctAnswer:'C',officialExplanation:'文件目录项即FCB。',status:'auto_paired',issues:[],questionPage:96,answerPage:107};
const sources=[{id:'os',name:'操作系统',questionRecords:[q]}];
const query='做一下这个题\nFAT32的文件目录项不包括（）。\nA. 文件名；\nB. 文件访问权限说明；\nC. 文件控制块的物理位置；\nD. 文件所在的物理位置';
test('FAT32 screenshot transcription retrieves the bound answer, not an unrelated answer number',()=>{const [ref]=linkedQuestionEvidence(sources,['os'],query);assert.equal(ref.questionId,'fat32');assert.equal(ref.answerVerified,false);assert.match(ref.text,/候选答案：C/);assert.match(ref.text,/答案 PDF 页：107/)});
test('changed negation, options, unselected source and duplicate stems do not establish identity',()=>{
 assert.equal(linkedQuestionEvidence(sources,['os'],query.replace('不包括','包括')).length,0);
 assert.equal(linkedQuestionEvidence(sources,['os'],query.replace('B. 文件访问权限说明','B. 文件大小')).length,0);
 assert.equal(linkedQuestionEvidence(sources,[],query).length,0);
 assert.equal(linkedQuestionEvidence([{...sources[0],questionRecords:[q,{...q,questionId:'other'}]}],['os'],query).length,0);
});
