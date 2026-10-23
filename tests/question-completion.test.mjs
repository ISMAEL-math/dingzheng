import * as questionModel from '../public/question-model.js';
import {createPaperUI} from '../public/paper-ui.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import * as completion from '../public/question-completion.js';
import * as presentation from '../public/question-presentation.js';
import { normalizeNotebooks, collectQuestions } from '../public/notebook-model.js';
import { createNotebookUI } from '../public/notebook-ui.js';

const original = '已知函数 f(x)=2x+3，在区间[0,1]上，[无法辨认]';
const full = '已知函数 f(x)=2x+3，在区间[0,1]上，求该函数最大值。';
const ref = {source:'函数练习.pdf',sourceId:'book',chunkId:'p2-1',pageNumber:2,text:full};
const evidence = completion.completionEvidence([ref]);
const proposal = () => ({status:'completed',sameQuestion:true,confidence:'high',reason:'原卷中函数与区间一致，知识库提供缺失的设问',matchAnchors:[{text:'已知函数 f(x)=2x+3，在区间[0,1]上',evidenceId:'K1'}],patches:[{action:'replace_missing',anchor:'上，[无法辨认]',text:'求该函数最大值。',evidenceId:'K1',quote:full}]});
const apply = value => completion.validateQuestionCompletion(original,value,evidence);

test('completion replaces only the OCR marker and keeps a verifiable original and source',()=>{
  const result=apply(proposal());assert.equal(result.question,full);assert.equal(result.completion.originalQuestion,original);
  assert.equal(result.completion.sources[0].pageNumber,2);assert.equal(result.completion.sources[0].quote,full);
  assert.equal(completion.validQuestionCompletionRecord(result.completion),true);
});
test('missing options can be inserted without rewriting the readable options',()=>{
  const question='已知函数 f(x)=2x+3，在区间[0,1]上，下列说法正确的是：\nA. 递减\nB. 最小值为3';
  const source=question+'\nC. 最大值为5\nD. 恒为0';const p=proposal();p.patches=[{action:'insert_after',anchor:'B. 最小值为3',text:'\nC. 最大值为5\nD. 恒为0',evidenceId:'K1',quote:source}];
  const result=completion.validateQuestionCompletion(question,p,completion.completionEvidence([{...ref,text:source}]));
  assert.equal(result.question,source);assert.ok(result.question.startsWith(question));
});
test('model uncertainty, changed readable text, invented text and invented citations cannot change the question',()=>{
  for(const change of [p=>p.confidence='low',p=>p.sameQuestion=false,p=>p.status='uncertain',p=>p.patches[0].anchor='已知函数',p=>p.patches[0].text='由此证明函数恒定',p=>p.patches[0].evidenceId='K99']){
    const p=proposal();change(p);assert.equal(apply(p).question,original);
  }
});
test('matching a general topic without the readable original conditions is rejected',()=>{
  const p=proposal();p.matchAnchors=[{text:'下列说法中正确的是',evidenceId:'K1'}];assert.equal(apply(p).question,original);
});
test('conflicting numeric versions of a question are rejected',()=>{
  const question=original.replace('2x+3','2x+7');const p=proposal();p.matchAnchors=[{text:'在区间[0,1]上，',evidenceId:'K1'},{text:'已知函数 f(x)=2x+',evidenceId:'K1'}];
  assert.equal(completion.validateQuestionCompletion(question,p,evidence).question,question);
});
test('a source answer cannot be inserted into the question or a legitimate answer blank',()=>{
  const question='已知函数 f(x)=2x+3，在区间[0,1]上，最大值为 ____。';const source=question+'\n答案：5';const p=proposal();p.patches=[{action:'insert_before',anchor:'____',text:'5',evidenceId:'K1',quote:source}];
  assert.equal(completion.validateQuestionCompletion(question,p,completion.completionEvidence([{...ref,text:source}])).question,question);
  p.patches[0]={action:'replace_missing',anchor:'____',text:'5',evidenceId:'K1',quote:question};assert.equal(completion.validateQuestionCompletion(question,p,evidence).question,question);
});
test('ambiguous or overlapping patch locations are rejected atomically',()=>{
  const question=original+' [无法辨认]';const p=proposal();p.patches[0].anchor='[无法辨认]';assert.equal(completion.validateQuestionCompletion(question,p,evidence).question,question);
  const duplicate=proposal();duplicate.patches.push({...duplicate.patches[0]});assert.equal(apply(duplicate).question,original);
});
test('search query removes OCR uncertainty but preserves real fill-in blanks and formulas',()=>{
  assert.equal(completion.completionQuery('x=[无法辨认]，填空 ____。'),'x= ，填空 ____。');
  assert.equal(completion.completionEvidence([{...ref,kind:'toc'},ref])[0].evidenceId,'K1');
});
test('backup provenance rejects malformed nested fields and round-trips valid metadata',()=>{
  const record=apply(proposal()).completion;assert.equal(completion.validQuestionCompletionRecord(JSON.parse(JSON.stringify(record))),true);
  assert.equal(completion.validQuestionCompletionRecord({...record,sources:[{...record.sources[0],quote:{html:'bad'}}]}),false);
  assert.equal(completion.validQuestionCompletionRecord({...record,originalQuestion:5}),false);
});

const appSource=(await readFile(new URL('../public/app.js',import.meta.url),'utf8')).replace(/^import .*\n/gm,'').replace(/await Promise\.all\(\[load\(\),loadServerConfig\(\),refreshCodexStatus\(\)\]\);state=normalizeNotebooks\(state\);render\(\);/,'');
function app(){
  const root={innerHTML:'',scrollTop:0,querySelectorAll:()=>[],querySelector:()=>null},fields=new Map([['#camera-capture',{}]]);
  const document={querySelector:selector=>selector==='#page-root'||selector==='#modal-root'?root:fields.get(selector)||null,querySelectorAll:()=>[],addEventListener(){}};
  const context=vm.createContext({...questionModel,createPaperUI,...completion,...presentation,normalizeNotebooks,collectQuestions,createNotebookUI,document,window:{matchMedia:()=>({matches:true,addEventListener(){}}),scrollTo(){}},indexedDB:{open:()=>({})},console,AbortController,AbortSignal,DOMException,setTimeout,clearTimeout,requestAnimationFrame:fn=>fn(),renderChatMarkdown:x=>x,crypto:{randomUUID:()=> 'generated'}});
  vm.runInContext(appSource,context);const run=code=>vm.runInContext(code,context);
  context.fixtureOriginal=original;context.fixtureFull=full;context.fixtureRef=ref;context.fixtureProposal=proposal();
  run(`save=async snapshot=>{globalThis.lastSaved=snapshot};render=()=>{};notify=message=>{globalThis.notice=message};state.sources=[{id:'book',name:'函数练习.pdf',chunks:[{id:'p2-1',text:fixtureFull,pageNumber:2}]}];retrieveContext=async()=>[fixtureRef];globalThis.calls=[];callChat=async body=>{calls.push(body);return {choices:[{message:{content:JSON.stringify(body.messages[0].content===completionSystemPrompt?fixtureProposal:{status:'正确',score:1,maxScore:1,correctAnswer:'5',explanation:'函数递增，最大值为5',source:'函数练习.pdf'})}}]}};`);
  return {run,context,root};
}
test('grading consumes the completed question while retaining the untouched student answer',async()=>{
  const a=app();const result=await a.run(`runGradingAgent({item:{number:'8',question:fixtureOriginal,studentAnswer:'手写作答 5',maxScore:null},subject:'数学',sourceId:'book',signal:new AbortController().signal,onStatus:()=>{}})`);
  assert.equal(result.questionItem.question,full);assert.equal(result.questionItem.recognizedQuestion,original);assert.equal(result.questionItem.studentAnswer,'手写作答 5');
  assert.match(a.run('calls[1].messages[1].content'),/求该函数最大值/);assert.match(a.run('calls[1].messages[1].content'),/手写作答 5/);
  assert.equal('studentAnswer' in JSON.parse(a.run('calls[0].messages[1].content')),false);
});
test('unmatched or unavailable knowledge keeps the OCR question and normal grading works',async()=>{
  const a=app();a.run("fixtureProposal.status='uncertain';fixtureProposal.patches=[]");
  const result=await a.run(`runGradingAgent({item:{question:fixtureOriginal,studentAnswer:'原作答'},signal:new AbortController().signal,onStatus:()=>{}})`);
  assert.equal(result.questionItem.question,original);assert.equal(result.questionItem.questionCompletion.status,'unmatched');
  const b=app();b.run('state.sources=[];retrieveContext=async()=>[]');const noKnowledge=await b.run(`runGradingAgent({item:{question:fixtureOriginal},signal:new AbortController().signal,onStatus:()=>{}})`);
  assert.equal(noKnowledge.questionItem.question,original);assert.equal(b.run('calls.length'),1);
});
test('an API failure during completion does not prevent grading the original question',async()=>{
  const a=app();a.run("const originalChat=callChat;callChat=async body=>{if(body.messages[0].content===completionSystemPrompt)throw new Error('completion unavailable');return originalChat(body)}");
  const result=await a.run(`runGradingAgent({item:{question:fixtureOriginal},signal:new AbortController().signal,onStatus:()=>{}})`);
  assert.equal(result.questionItem.question,original);assert.equal(result.questionItem.questionCompletion.status,'failed');assert.equal(result.result.status,'正确');
});
function savedSession(a){a.run(`state.page='result';state.lastSession='old';state.sessions=[{id:'old',title:'旧记录',subject:'数学',sourceId:'book',scoringMode:'accuracy',images:[],questions:[{number:'8',question:fixtureOriginal,studentAnswer:'原始手写作答',status:'错误',score:0,maxScore:1,hasExplicitScore:false}]}];state.mistakes=[{id:'mistake',sourceSessionId:'old',questionIndex:0,question:fixtureOriginal,status:'待复习'}];hasApiKey=()=>true`)}
test('the existing result-page event binder connects the completion button to the saved question',async()=>{
  const a=app();savedSession(a);const button={dataset:{completeQuestion:'old:0'}};
  a.root.querySelectorAll=selector=>selector==='[data-complete-question]'?[button]:[];
  a.run('bindResult()');assert.equal(typeof button.onclick,'function');await button.onclick();
  assert.equal(a.run('state.sessions[0].questions[0].question'),full);assert.equal(a.run('questionCompletionBusy.size'),0);
});
test('existing results complete and regrade atomically, synchronizing collected mistakes',async()=>{
  const a=app();savedSession(a);await a.run(`completeResultQuestion('old',0)`);
  assert.equal(a.run('state.sessions[0].questions[0].question'),full);assert.equal(a.run('state.sessions[0].questions[0].recognizedQuestion'),original);
  assert.equal(a.run('state.sessions[0].questions[0].studentAnswer'),'原始手写作答');assert.equal(a.run('state.sessions[0].questions[0].status'),'正确');assert.equal(a.run('state.sessions[0].questions[0].hasExplicitScore'),false);
  assert.equal(a.run('state.mistakes[0].question'),full);assert.equal(a.run('state.mistakes[0].status'),'已掌握');assert.equal(a.run('state.mistakes[0].questionCompletion.status'),'completed');
  const markup=a.run('questionDetailMarkup(state.sessions[0],state.sessions[0].questions[0],0)');assert.match(markup,/题面已结合知识库补全/);assert.match(markup,/原卷识别原文/);assert.match(markup,/函数练习.pdf · 第 2 页/);
});
test('no matching completion leaves previous grading unchanged and skips regrading',async()=>{
  const a=app();savedSession(a);a.run("fixtureProposal.status='uncertain';fixtureProposal.patches=[]");await a.run(`completeResultQuestion('old',0)`);
  assert.equal(a.run('state.sessions[0].questions[0].question'),original);assert.equal(a.run('state.sessions[0].questions[0].status'),'错误');assert.equal(a.run('calls.length'),1);
});
test('failed persistence and concurrent edits cannot replace the saved question',async()=>{
  const a=app();savedSession(a);a.run("save=async()=>{throw new Error('quota')}");await a.run(`completeResultQuestion('old',0)`);assert.equal(a.run('state.sessions[0].questions[0].question'),original);assert.equal(a.run('state.mistakes[0].question'),original);assert.match(a.run('notice'),/quota/);
  const b=app();savedSession(b);b.run("const originalChat=callChat;callChat=async body=>{const response=await originalChat(body);if(body.messages[0].content!==completionSystemPrompt)state.sessions[0].questions[0].question='人工修改';return response}");await b.run(`completeResultQuestion('old',0)`);assert.equal(b.run('state.sessions[0].questions[0].question'),'人工修改');assert.match(b.run('notice'),/未覆盖新内容/);
});
test('a retry retains provenance when no further completion is necessary',async()=>{
  const a=app();savedSession(a);await a.run(`completeResultQuestion('old',0)`);a.run("fixtureProposal.status='unchanged';fixtureProposal.patches=[]");await a.run(`completeResultQuestion('old',0)`);assert.equal(a.run('state.sessions[0].questions[0].questionCompletion.status'),'completed');assert.equal(a.run('state.sessions[0].questions[0].questionCompletion.sources.length'),1);
});
test('completion provenance survives collection and backup restoration',async()=>{
  const a=app();savedSession(a);await a.run(`completeResultQuestion('old',0)`);
  a.run(`globalThis.restored=validateBackup(JSON.parse(JSON.stringify(state)))`);
  assert.equal(a.run('restored.sessions[0].questions[0].recognizedQuestion'),original);
  assert.equal(a.run('restored.mistakes[0].questionCompletion.sources[0].pageNumber'),2);
  a.run(`state.mistakes=[];globalThis.collected=collectQuestions(state,'old',[0],{subject:'数学',name:'函数题'})`);
  assert.equal(a.run('collected.next.mistakes[0].recognizedQuestion'),original);
  assert.equal(a.run('collected.next.mistakes[0].questionCompletion.completedQuestion'),full);
});
test('incremental completion retains both earlier edits and the original OCR record',async()=>{
  const a=app();savedSession(a);
  a.run(`fixtureOriginal='已知函数 f(x)=2x+3，在区间[0,1]上，[无法辨认]；[无法辨认]';fixtureFull='已知函数 f(x)=2x+3，在区间[0,1]上，求最大值；判断单调性';fixtureRef={...fixtureRef,text:fixtureFull};state.sources[0].chunks[0].text=fixtureFull;state.sessions[0].questions[0].question=fixtureOriginal;fixtureProposal.patches=[{action:'replace_missing',anchor:'上，[无法辨认]',text:'求最大值',evidenceId:'K1',quote:fixtureFull}]`);
  await a.run(`completeResultQuestion('old',0)`);
  a.run(`fixtureProposal.patches=[{action:'replace_missing',anchor:'；[无法辨认]',text:'判断单调性',evidenceId:'K1',quote:fixtureFull}]`);
  await a.run(`completeResultQuestion('old',0)`);
  assert.equal(a.run('state.sessions[0].questions[0].question'),a.run('fixtureFull'));
  assert.equal(a.run('state.sessions[0].questions[0].recognizedQuestion'),a.run('fixtureOriginal'));
  assert.equal(a.run('state.sessions[0].questions[0].questionCompletion.changes.length'),2);
  assert.equal(a.run('validQuestionCompletionRecord(state.sessions[0].questions[0].questionCompletion)'),true);
});
test('cancelling during completion stops before grading without changing the recognized question',async()=>{
  const a=app();a.run(`globalThis.cancelController=new AbortController();callChat=async(body,signal)=>new Promise((resolve,reject)=>{globalThis.waitingForCompletion=true;signal.addEventListener('abort',()=>reject(signal.reason),{once:true})})`);
  const running=a.run(`runGradingAgent({item:{question:fixtureOriginal},signal:cancelController.signal,onStatus:()=>{}})`);
  for(let i=0;i<20&&!a.run('Boolean(globalThis.waitingForCompletion)');i++)await Promise.resolve();
  a.run('cancelController.abort()');await assert.rejects(running,error=>error.name==='AbortError');assert.equal(a.run('fixtureOriginal'),original);
});
test('completion is persisted before grading and is reused when a grading job resumes',async()=>{
  const a=app();a.run(`state.page='grade';gradeDraft={title:'函数',subject:'数学',sourceId:'book',focus:''};selectedPhotos=['photo'];hasApiKey=()=>true;saveGradingPhotos=async()=>{};deleteGradingPhotos=async()=>{};globalThis.countsForTest={vision:0,completion:0,grade:0};const originalChat=callChat;callChat=async body=>{if(body.model===state.settings.visionModel){countsForTest.vision++;return {choices:[{message:{content:JSON.stringify({questions:[{number:'8',question:fixtureOriginal,studentAnswer:'原始作答',maxScore:null}]})}}]}}if(body.messages[0].content===completionSystemPrompt)countsForTest.completion++;else{countsForTest.grade++;if(countsForTest.grade===1)throw new Error('grade failed')}return originalChat(body)};`);
  await a.run('gradePhotos(false)');assert.equal(a.run('state.gradingJob.pages[0].items[0].question'),full);assert.equal(a.run('state.gradingJob.status'),'failed');
  await a.run('gradePhotos(true)');assert.equal(a.run('state.sessions[0].questions[0].question'),full);assert.equal(a.run('state.sessions[0].questions[0].recognizedQuestion'),original);
  assert.deepEqual(JSON.parse(a.run('JSON.stringify(countsForTest)')),{vision:1,completion:1,grade:2});
});
