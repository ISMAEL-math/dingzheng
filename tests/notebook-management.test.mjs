import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeNotebooks, collectQuestions, filterMistakes, removeMistakes, renameNotebook, removeNotebook, renameSubject, removeSubject, renameTag, removeTag, updateMistake } from '../public/notebook-model.js';
import { questionType, questionGroup, questionIssues, questionSignature, needsQuestionReview, groupPaperQuestions } from '../public/question-model.js';
import { paperQuestionMarkup } from '../public/paper-ui.js';

const image='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jY1kAAAAASUVORK5CYII=';
function fixture(){
 return normalizeNotebooks({subjects:['数学','物理'],notebooks:[{id:'b1',subject:'数学',name:'函数'},{id:'b2',subject:'物理',name:'电学'}],tags:['易错','考前'],sessions:[{id:'s1',images:[image],questions:[{question:'函数的最大值为（　）A. 1 B. 2 C. 3 D. 4',type:'单项选择题',number:'1',status:'错误',correctAnswer:'D',imageIndex:0}]}],mistakes:[{id:'m1',sourceSessionId:'s1',questionIndex:0,notebookId:'b1',subject:'数学',question:'函数的最大值为（　）A. 1 B. 2 C. 3 D. 4',tags:['易错'],status:'待复习'},{id:'m2',notebookId:'b2',subject:'物理',type:'解答题',question:'计算导体两端的电压。',tags:['考前'],status:'待复习'}],paperDraft:{questionIds:['m1','m2']}});
}
test('old notebooks recover types from source records and unknown types stay editable',()=>{
 const data=fixture();assert.equal(data.mistakes[0].type,'单选题');assert.equal(questionGroup(data.mistakes[0]),'选择题');
 assert.equal(questionType({type:'计算题'}),'解答题');assert.equal(questionType({question:'未知内容'}),'待分类');
 assert.deepEqual(filterMistakes(data,{group:'选择题'}).map(m=>m.id),['m1']);
});
test('new collection contains structured types, subquestions and necessary figures without original photos',()=>{
 const data=fixture();data.mistakes=[];data.sessions[0].questions[0].figures=[{src:image,caption:'示意图'}];data.sessions[0].questions[0].parts=[{number:'1',question:'说明理由'}];
 const {next}=collectQuestions(data,'s1',[0],{notebookId:'b1'},()=> 'new');
 assert.equal(next.mistakes[0].type,'单选题');assert.equal(next.mistakes[0].image,undefined);assert.equal(next.mistakes[0].figures[0].src,image);assert.equal(next.mistakes[0].parts[0].question,'说明理由');assert.equal(next.sessions[0].images[0],image);
});
test('deleting selected questions also removes paper references and retains source records',()=>{
 const data=fixture(),next=removeMistakes(data,['m1']);assert.deepEqual(next.mistakes.map(m=>m.id),['m2']);assert.deepEqual(next.paperDraft.questionIds,['m2']);assert.equal(next.sessions,data.sessions);assert.equal(data.mistakes.length,2);
});
test('notebook deletion requires a content choice and can move questions across subjects',()=>{
 const data=fixture();assert.throws(()=>removeNotebook(data,'b1'),/请选择/);
 assert.throws(()=>removeNotebook(data,'b1',{mode:'move',targetNotebookId:'b1'}),/接收/);
 const moved=removeNotebook(data,'b1',{mode:'move',targetNotebookId:'b2'});assert.equal(moved.notebooks.length,1);assert.equal(moved.mistakes[0].notebookId,'b2');assert.equal(moved.mistakes[0].subject,'物理');assert.equal(moved.mistakes.length,2);
 const deleted=removeNotebook(data,'b1',{mode:'delete'});assert.deepEqual(deleted.mistakes.map(m=>m.id),['m2']);assert.equal(deleted.sessions,data.sessions);
});
test('subject rename and move synchronize all notebooks and questions without merging duplicate names',()=>{
 const data=fixture(),renamed=renameSubject(data,'数学','高数');assert.equal(renamed.notebooks[0].subject,'高数');assert.equal(renamed.mistakes[0].subject,'高数');assert.throws(()=>renameSubject(data,'数学','物理'),/同名/);
 const moved=removeSubject(data,'数学',{mode:'move',targetSubject:'物理'});assert.deepEqual(moved.subjects,['物理']);assert.ok(moved.notebooks.every(b=>b.subject==='物理'));assert.equal(moved.mistakes.length,2);
 data.notebooks[1].name='函数';assert.throws(()=>removeSubject(data,'数学',{mode:'move',targetSubject:'物理'}),/同名/);
});
test('deleting a subject handles empty notebooks and preserves unrelated data',()=>{
 const data=fixture();const deleted=removeSubject(data,'数学',{mode:'delete'});assert.deepEqual(deleted.mistakes.map(m=>m.id),['m2']);assert.deepEqual(deleted.notebooks.map(b=>b.id),['b2']);
 data.mistakes=[];assert.equal(removeSubject(data,'数学',{mode:'delete'}).notebooks.length,1);
});
test('tag rename and deletion update every question without deleting questions',()=>{
 const data=fixture(),renamed=renameTag(data,'易错','概念不清');assert.deepEqual(renamed.mistakes[0].tags,['概念不清']);assert.throws(()=>renameTag(data,'易错','考前'),/同名/);
 const deleted=removeTag(data,'易错');assert.deepEqual(deleted.mistakes[0].tags,[]);assert.equal(deleted.mistakes.length,2);assert.equal(renameNotebook(data,'b1','极限').notebooks[0].name,'极限');
});
test('notebook editing synchronizes cleaned text and type to source while keeping OCR and photos',()=>{
 const data=fixture(),before=structuredClone(data),patch={type:'多选题',question:'选择正确项。\nA. 甲\nB. 乙\nC. 丙\nD. 丁',correctAnswer:'AB',figures:[{src:image,caption:'必要附图'}]};
 const next=updateMistake(data,'m1',patch,true);assert.equal(next.sessions[0].questions[0].question,patch.question);assert.equal(next.sessions[0].questions[0].type,'多选题');assert.equal(next.sessions[0].questions[0].recognizedQuestion,before.sessions[0].questions[0].question);assert.deepEqual(next.sessions[0].images,[image]);assert.equal(needsQuestionReview(next.mistakes[0]),false);assert.deepEqual(data,before);
 assert.throws(()=>updateMistake(data,'m1',{...patch,question:' '}),/题干/);
});
test('integrity checks identify incomplete stems, missing labels, figures and malformed math',()=>{
 assert.ok(questionIssues({type:'单选题',question:'选择正确项。A. 甲 B. 乙 D. 丁'}).some(issue=>issue.includes('编号')));
 assert.ok(questionIssues({type:'解答题',question:'已知函数，'}).some(issue=>issue.includes('结束')));
 assert.ok(questionIssues({type:'解答题',question:'如图，求电流。'}).some(issue=>issue.includes('附图')));
 assert.ok(questionIssues({type:'解答题',question:'求 $\\frac{1}{2$ 的值。'}).some(issue=>issue.includes('括号')));
 assert.ok(questionIssues({type:'解答题',question:'已知 \\(x+1，求值。'}).some(issue=>issue.includes('分隔符')));
 assert.equal(questionIssues({type:'填空题',question:'方程 $x+1=2$ 的解是____。'}).length,0);
});
test('manual review only acknowledges the exact current content including figure captions',()=>{
 const item={type:'单选题',question:'选择正确项：A. 甲 B. 乙'};assert.equal(needsQuestionReview(item),true);
 item.reviewedSignature=questionSignature(item);assert.equal(needsQuestionReview(item),false);item.question+='，';assert.equal(needsQuestionReview(item),true);
 assert.ok(questionSignature({...item,figures:[{src:image,caption:'图一'}]}).length<80);
});
test('paper groups types and numbers questions and answers in the same order',()=>{
 const groups=groupPaperQuestions([{id:'essay',type:'解答题'},{id:'choice',type:'单选题'},{id:'fill',type:'填空题'},{id:'multi',type:'多选题'}]);
 assert.deepEqual(groups.flatMap(section=>section.items).map(m=>[m.id,m.paperNumber]),[['choice',1],['multi',2],['fill',3],['essay',4]]);
});
test('paper uses aligned choices and per-part writing space without original-image appendices',()=>{
 const h={esc:String,markdown:String},choice=paperQuestionMarkup({id:'c',paperNumber:1,type:'单选题',question:'选正确项。A. 甲 B. 乙 C. 丙 D. 丁',image:'original-photo'},h);
 assert.match(choice,/columns-4/);assert.doesNotMatch(choice,/original-photo|paper-answer-lines|exam-workspace/);
 const essay=paperQuestionMarkup({id:'e',paperNumber:2,type:'解答题',question:'完成下列小问。',parts:[{number:'1',question:'求导'},{number:'2',question:'求极值'}]},h);
 assert.equal((essay.match(/class="exam-workspace"/gu)||[]).length,2);
});
