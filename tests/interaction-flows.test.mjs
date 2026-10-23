import * as questionModel from '../public/question-model.js';
import {createPaperUI} from '../public/paper-ui.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {normalizeNotebooks,collectQuestions} from '../public/notebook-model.js';
import {createNotebookUI} from '../public/notebook-ui.js';
import {readFile} from 'node:fs/promises';
import * as questionCompletion from '../public/question-completion.js';
import * as questionPresentation from '../public/question-presentation.js';
import * as chatModels from '../public/chat-models.mjs';
const source=(await readFile(new URL('../public/app.js',import.meta.url),'utf8')).replace(/^import .*\n/gm,'').replace(/await Promise\.all\(\[load\(\),loadServerConfig\(\),refreshCodexStatus\(\)\]\);state=normalizeNotebooks\(state\);render\(\);/,'');
function setup(){
 const fields=new Map([['#camera-capture',{}]]),chatModelCheckboxes=[]; const root={innerHTML:'',scrollTop:0,querySelectorAll:selector=>selector==='[data-enabled-chat-model]'?chatModelCheckboxes:[]};
 const document={querySelector:s=>s==='#page-root'||s==='#modal-root'?root:fields.get(s)||null,querySelectorAll:()=>[],addEventListener:()=>{}};
 let generatedId=0;const context=vm.createContext({...questionModel,...chatModels,createPaperUI,...questionCompletion,...questionPresentation,isDocumentWideQuery:()=>false,normalizeNotebooks,collectQuestions,createNotebookUI,document,window:{matchMedia:()=>({matches:true,addEventListener(){}}),scrollTo(){}},indexedDB:{open:()=>({})},console,AbortController,AbortSignal,DOMException,setTimeout,clearTimeout,requestAnimationFrame:fn=>fn(),renderChatMarkdown:x=>x,crypto:{randomUUID:()=> `fixture-${++generatedId}`}});
 vm.runInContext(source,context);
 vm.runInContext('save=async snapshot=>{globalThis.lastSaved=snapshot};render=()=>{};notify=()=>{};',context);
 const run=code=>vm.runInContext(code,context);
 const field=(id,value)=>{fields.set('#'+id,{value,textContent:'',disabled:false});return fields.get('#'+id)};
 const settings=()=>{for(const [id,value] of Object.entries({'api-key':'','mineru-api-key':'','settings-pdf-parser':'text_only','model-vision':'vision','model-chat':'chat','model-embedding':'embedding'}))field(id,value)};
 const checkbox=(value,checked)=>{const input={value,checked};chatModelCheckboxes.push(input);return input};
 return {run,field,fields,settings,checkbox};
}
test('failed settings storage keeps saved configuration and unsaved draft',async()=>{const a=setup();a.settings();a.field('model-chat','new-model');a.run("state.settings.chatModel='original';save=async()=>{throw new Error('quota')}");await a.run('commitSettings()');assert.equal(a.run('state.settings.chatModel'),'original');assert.equal(a.run('settingsDraft.chatModel'),'new-model');assert.match(a.run('settingsMessage'),/保存失败/);assert.equal(a.run('settingsSaving'),false)});
test('successful settings commit persists candidate before replacing live settings',async()=>{const a=setup();a.settings();a.field('model-chat',' new-model ');await a.run('commitSettings()');assert.equal(a.run('lastSaved.settings.chatModel'),'new-model');assert.equal(a.run('state.settings.chatModel'),'new-model');assert.equal(a.run('settingsDirty()'),false)});
test('settings save the selected chat-model allowlist and always keep the default model enabled',async()=>{const a=setup();a.settings();a.checkbox('chat',false);a.checkbox('another-enabled-model',true);await a.run('commitSettings()');assert.deepEqual(JSON.parse(JSON.stringify(a.run('lastSaved.settings.enabledChatModels'))),['another-enabled-model','chat'])});
test('home picker contains only enabled language models',()=>{const a=setup();a.run("serverKeyAvailable=true;state.settings.chatModel='vendor/enabled';state.settings.enabledChatModels=['vendor/enabled'];modelCatalog.chat=['vendor/enabled','vendor/disabled','Qwen/Qwen3-VL-32B-Instruct','Qwen/Qwen3-Embedding-8B']");const groups=JSON.parse(JSON.stringify(a.run('chatModelGroups()')));assert.deepEqual(groups[0].items.map(item=>item.id),['vendor/enabled'])});
test('empty model names cannot be saved',async()=>{const a=setup();a.settings();a.field('model-chat',' ');await a.run('commitSettings()');assert.equal(a.run('typeof lastSaved'),'undefined');assert.equal(a.run('settingsError'),true)});
test('new conversation waits for streaming shutdown and keeps the old unsent draft',async()=>{const a=setup();a.run("state.activeChatId='old';state.page='home';composerDraft='unfinished';chatBusy=true;chatTask=new Promise(resolve=>{globalThis.finishChat=resolve});chatAbort={abort(){chatBusy=false;finishChat()}}");await a.run('newConversation()');assert.equal(a.run('state.activeChatId'),null);assert.equal(a.run("chatDrafts.get('old').text"),'unfinished');assert.equal(a.run('composerDraft'),'');assert.equal(a.run('state.chats.length'),0)});
test('new conversation on the empty composer keeps its draft',async()=>{const a=setup();a.run("state.activeChatId=null;state.page='home';composerDraft='draft question'");await a.run('newConversation()');assert.equal(a.run('composerDraft'),'draft question')});
test('deleting a conversation preserves collected questions and undo restores only changed data',async()=>{
 const a=setup();a.run("state.chats=[{id:'c1',title:'讨论',messages:[]}];state.mistakes=[{id:'m1'}];state.activeChatId='c1';state.questionChats={q1:'c1'};state.page='home';");
 await a.run("deleteConversation('c1')");assert.equal(a.run('state.chats.length'),0);assert.equal(a.run('state.mistakes.length'),1);assert.equal(a.run('state.activeChatId'),null);
 a.run("state.sources=[{id:'new-source'}]");await a.run('undoLastStudyChange()');assert.equal(a.run('state.chats[0].id'),'c1');assert.equal(a.run('state.questionChats.q1'),'c1');assert.equal(a.run('state.sources[0].id'),'new-source');
});
test('deletion persistence failure leaves the visible conversation and notes unchanged',async()=>{
 const a=setup();a.run("state.chats=[{id:'c1',title:'讨论',messages:[]}];state.mistakes=[{id:'m1'}];state.activeChatId='c1';save=async()=>{throw new Error('quota')}");
 await assert.rejects(a.run("deleteConversation('c1')"),/quota/);assert.equal(a.run('state.chats.length'),1);assert.equal(a.run('state.activeChatId'),'c1');assert.equal(a.run('state.mistakes.length'),1);
});
test('undo refuses to overwrite subsequent edits to deleted content',async()=>{
 const a=setup();a.run("state.chats=[{id:'c1',title:'讨论',messages:[]}];state.activeChatId=null");await a.run("deleteConversation('c1')");
 a.run("state.chats.push({id:'new-chat',title:'新对话',messages:[]})");await a.run('undoLastStudyChange()');assert.equal(a.run('state.chats.length'),1);assert.equal(a.run('state.chats[0].id'),'new-chat');
});
test('deleting a currently streaming conversation waits for cancellation before storing the deletion',async()=>{
 const a=setup();a.run("state.chats=[{id:'c1',title:'讨论',messages:[]}];state.activeChatId='c1';chatBusy=true;chatTask=new Promise(resolve=>{globalThis.stopChat=resolve});chatAbort={abort(){chatBusy=false;state.chats[0].messages.push({role:'assistant',content:'已停止'});stopChat()}}");
 await a.run("deleteConversation('c1')");assert.equal(a.run('state.chats.length'),0);assert.equal(a.run('lastSaved.chats.length'),0);await a.run('undoLastStudyChange()');assert.equal(a.run('state.chats[0].messages[0].content'),'已停止');
});
test('assignment fields survive page transitions',()=>{const a=setup();for(const [id,value] of Object.entries({'grade-title':'Chapter 3','grade-subject':'Math','grading-focus':'steps','grade-source':'s1'}))a.field(id,value);a.run("setPage('library')");assert.equal(a.run('gradeDraft.title'),'Chapter 3');assert.equal(a.run('gradeDraft.focus'),'steps')});
test('result summary and heatmap derive one consistent score and three visible states',()=>{const a=setup();a.run("state.sessions=[{id:'exam',title:'代数练习',createdAt:1,subject:'数学',images:[],questions:[{number:'1',question:'一元方程',status:'错误',score:2,maxScore:2},{number:'2',question:'函数',status:'部分正确',score:.5,maxScore:1},{number:'3',question:'几何',status:'错误',score:0,maxScore:1},{number:'4',question:'概率',status:'待确认'}]}];state.lastSession='exam';state.page='result';currentResultSessionId='';");const markup=a.run('resultPage()');assert.match(markup,/正确率 25%，1 \/ 4 题答对/);assert.match(markup,/<strong>25%<\/strong>/);assert.match(markup,/data-result-question="0"/);assert.match(markup,/data-result-question="3"/);assert.match(markup,/第 1 题，答对/);assert.match(markup,/第 2 题，部分正确/);assert.match(markup,/第 3 题，答错/);assert.match(markup,/第 4 题，待确认/);assert.doesNotMatch(markup,/grading-count-item|question-map-symbol/)});
test('question detail keeps the source question and focuses on the selected state',()=>{const a=setup();const markup=a.run("questionDetailMarkup({id:'exam',images:['page']},{number:'2a',question:'\\\\(x^2=4\\\\)',studentAnswer:'x=2',correctAnswer:'x=\\\\pm 2',status:'部分正确',score:1,maxScore:2,explanation:'漏掉负根',imageIndex:0},1)");assert.match(markup,/第 2a 题/);assert.doesNotMatch(markup,/<small>1 \/ 2 分<\/small>/);assert.match(markup,/失分原因与批改反馈/);assert.match(markup,/data-open-question-chat=/);assert.match(markup,/data-toggle-question-mistake/);assert.match(markup,/data-correct-question=/);assert.match(markup,/src="page"/)});
test('choice presentation separates inline options and leaves saved text and tutor context untouched',()=>{
 const a=setup();a.run(`state.sessions=[{id:'choice',images:[],questions:[{number:'1',type:'单选题',question:'选择正确项：A. 甲 B. 乙 C. 丙 D. 丁',studentAnswer:'B',correctAnswer:'C',status:'错误'}]}]`);
 const before=a.run('JSON.stringify(state.sessions[0].questions[0])'),markup=a.run('questionDetailMarkup(state.sessions[0],state.sessions[0].questions[0],0)');
 assert.equal((markup.match(/class="result-choice-option"/g)||[]).length,4);assert.match(markup,/aria-label="题目选项"/);assert.match(markup,/result-question-prompt/);
 assert.equal(a.run('JSON.stringify(state.sessions[0].questions[0])'),before);assert.match(a.run('questionTutorContext(state.sessions[0],state.sessions[0].questions[0],0)'),/选择正确项：A\. 甲 B\. 乙 C\. 丙 D\. 丁/);
});
test('result collection persists through the notebook model and repeated adds are idempotent',async()=>{const a=setup();a.run("state.sessions=[{id:'exam',title:'试卷',subject:'数学',images:['page'],questions:[{number:'1',question:'题一',studentAnswer:'错',correctAnswer:'对',status:'错误'},{number:'2',question:'题二',status:'部分正确'},{number:'3',question:'题三',status:'正确'}]}];state.lastSession='exam';state.mistakes=[];state.notebooks=[];state.subjects=[];state.tags=[]");await a.run("collectResultQuestions('exam',[0,1],'bulk')");assert.equal(a.run('state.mistakes.length'),2);assert.equal(a.run('state.mistakes[0].subject'),'数学');await a.run("collectResultQuestions('exam',[0,1],'bulk')");assert.equal(a.run('state.mistakes.length'),2)});
test('question tutor action starts a regular chat with grading context and source photo',()=>{
 const a=setup();a.run(`state.sessions=[{id:'exam',title:'试卷',subject:'物理',images:['source-photo'],questions:[{number:'1',question:'位移',studentAnswer:'答案甲',correctAnswer:'标准甲',status:'错误',explanation:'符号反了',imageIndex:0}]}];state.lastSession='exam';state.page='result';state.chats=[{id:'old',title:'旧对话',messages:[]}];state.activeChatId='old';composerDraft='保留的草稿';pendingChatPhotos=['draft-photo'];pendingChatDocuments=[];state.selectedSourceIds=['book'];hasApiKey=()=>true;render=()=>{};globalThis.sentChat=null;sendChat=()=>{sentChat={id:state.activeChatId,text:composerDraft,photos:[...pendingChatPhotos]};return Promise.resolve()}`);
 const context=a.run("questionTutorContext(state.sessions[0],state.sessions[0].questions[0],0)");assert.match(context,/位移/);assert.match(context,/答案甲/);assert.match(context,/标准甲/);assert.match(context,/符号反了/);
 a.run("openQuestionInChat(state.sessions[0],state.sessions[0].questions[0],0)");
 assert.equal(a.run('state.page'),'home');assert.match(a.run('state.chats[0].title'),/第 1 题讲解/);assert.equal(a.run('state.chats[0].tutoringMode'),'answer_analysis');assert.equal(a.run('state.chats[0].questionContext.questionId'),'exam:question:0');assert.equal(a.run('sentChat.text'),'请从第一步开始讲解这道题，结合我的作答指出关键问题。');assert.deepEqual(Array.from(a.run('sentChat.photos')),['source-photo']);assert.equal(a.run("chatDrafts.get('old').text"),'保留的草稿');assert.equal(a.run('Object.keys(state.questionChats).length'),0);
});
test('tutor question IDs resolve exact stored records and reject missing or ambiguous IDs',()=>{
 const a=setup();a.run("state.sessions=[{id:'session-a',questions:[{number:'7',question:'第一题',status:'错误'},{number:'7',question:'第二题',status:'正确'}]},{id:'session-b',questions:[{number:'7',question:'第三题',status:'错误'}]}]");
 assert.equal(a.run("questionStableId(state.sessions[0],state.sessions[0].questions[1],1)"),'session-a:question:1');
 assert.equal(a.run("resolveTutoringQuestion('session-a:question:1').question.question"),'第二题');
 assert.equal(a.run("resolveTutoringQuestion('session-missing:question:7').status"),'missing');
 a.run("state.sessions[1].questions[0].questionId='duplicated'");a.run("state.sessions[0].questions[0].questionId='duplicated'");
 assert.equal(a.run("resolveTutoringQuestion('duplicated').status"),'ambiguous');
});
test('legacy tutoring chats migrate only from an exact unique question match',()=>{
 const a=setup();a.run(`const legacyChat={id:'legacy-chat',title:'第 03 题讲解 · 作业批改',messages:[{role:'user',content:'请讲解这道题。\\n试卷：作业批改\\n题号：第 03 题\\n批改判定：答错\\n原始题目：\\nFAT32 的文件目录项不包括（ ）。 A. 文件名 B. 文件访问权限说明 C. 文件控制块的物理位置 D. 文件所在的物理位置\\n\\n学生作答：\\nC\\n\\n参考答案：\\nB'}]};const sessions=[{id:'exam',title:'作业批改',questions:[{number:'03',question:'FAT32 的文件目录项不包括（ ）。 A. 文件名 B. 文件访问权限说明 C. 文件控制块的物理位置 D. 文件所在的物理位置',studentAnswer:'C'}]}];globalThis.migratedTutorChats=migrateLegacyTutoringChats([legacyChat],sessions);`);
 assert.equal(a.run('migratedTutorChats.changed'),true);assert.equal(a.run('migratedTutorChats.chats[0].questionContext.questionId'),'exam:question:0');assert.equal(a.run('migratedTutorChats.chats[0].tutoringMode'),'answer_analysis');
 a.run(`const ambiguousChat={id:'ambiguous-chat',title:'第 03 题讲解',messages:[{role:'user',content:'试卷：作业批改\\n题号：第 03 题\\n原始题目：\\n相同题干\\n学生作答：\\nA'}]};globalThis.ambiguousTutorChats=migrateLegacyTutoringChats([ambiguousChat],[{id:'a',title:'作业批改',questions:[{number:'03',question:'相同题干'}]},{id:'b',title:'作业批改',questions:[{number:'03',question:'相同题干'}]}]);`);
 assert.equal(a.run('ambiguousTutorChats.changed'),false);assert.equal(a.run('ambiguousTutorChats.chats[0].questionContext'),undefined);
});
test('tutor context displays answers in answer mode and keeps lecture mode knowledge-centered',()=>{
 const a=setup();a.run("state.sessions=[{id:'exam',title:'物理作业',subject:'物理',questions:[{number:'2',type:'单选题',question:'位移：A. 甲 B. 乙 C. 丙 D. 丁',studentAnswer:'B',correctAnswer:'C',source:'AI 推导',explanation:'方向判断错误',status:'错误'}]}];state.chats=[{id:'chat',questionContext:{questionId:'exam:question:0'},tutoringMode:'answer_analysis',messages:[]}];state.activeChatId='chat'");
 const answer=a.run('tutoringQuestionContextMarkup(activeChat())');assert.match(answer,/你的作答/);assert.match(answer,/批改记录中的参考答案/);assert.match(answer,/AI 推导/);assert.match(answer,/没有独立的教材官方解析/);assert.match(answer,/模型推理说明/);
 a.run("activeChat().tutoringMode='lecture'");const lecture=a.run('tutoringQuestionContextMarkup(activeChat())');assert.match(lecture,/讲义模式/);assert.doesNotMatch(lecture,/批改记录中的参考答案/);assert.match(a.run('tutoringModeControlMarkup(activeChat())'),/data-tutoring-mode="lecture" aria-pressed="true"/);
 const page=a.run('homePage()');assert.match(page,/data-tutoring-mode="answer_analysis"/);assert.match(page,/data-tutoring-mode="lecture"/);assert.match(page,/tutoring-lecture-context/);
});
test('answer tutoring never labels model reasoning as textbook official explanation',()=>{
 const a=setup();a.run("state.sessions=[{id:'exam',title:'物理作业',questions:[{number:'2',question:'位移判断题',studentAnswer:'错答',correctAnswer:'标准答案',status:'错误',source:'教材题库标准答案 · 物理教材 · 人工核验',explanation:'由模型根据定义补充的推理',explanationOrigin:'model',textbookRecord:{bookId:'book-1',questionId:'q-1',bookTitle:'物理教材',correctAnswer:'标准答案',officialExplanation:'',answerPage:12}}]}];state.chats=[{id:'chat',questionContext:{questionId:'exam:question:0'},tutoringMode:'answer_analysis',messages:[]}];state.activeChatId='chat'");
 const markup=a.run('tutoringQuestionContextMarkup(activeChat())');assert.match(markup,/模型推理说明/u);assert.match(markup,/教材记录未提供官方解析/u);assert.doesNotMatch(markup,/<h3>教材官方解析<\/h3>/u);
 a.run("state.sessions[0].questions[0].textbookRecord.officialExplanation='教材原文解析';state.sessions[0].questions[0].textbookRecord.explanationPage=13");
 const official=a.run('tutoringQuestionContextMarkup(activeChat())');assert.match(official,/教材官方解析/u);assert.match(official,/教材原文解析/u);assert.match(official,/解析页 13/u);
 const result=JSON.parse(JSON.stringify(a.run("gradingResultQuestion({number:'2',type:'single_choice',question:'题目',studentAnswer:'A'},0,[],{status:'正确',correctAnswer:'A',explanation:'程序比对结果',explanationOrigin:'deterministic',source:'教材题库'}, {status:'matched',book:{bookId:'book-1',title:'物理教材'},question:{questionId:'q-1',status:'verified',correctAnswer:'A',officialExplanation:'',answerPage:12}})")));
 assert.equal(result.explanationOrigin,'deterministic');assert.match(result.source,/教材题库标准答案 · 物理教材/u);
});
test('textbook import explains the MinerU free-tier limit when no key is configured',()=>{
 const a=setup();a.run("serverMineruKeyAvailable=false;state.settings.mineruApiKey=''");
 assert.match(a.run('textbookLibraryPage()'),/免密额度限 10 MB \/ 20 页/u);
 a.run("serverMineruKeyAvailable=true");assert.match(a.run('textbookLibraryPage()'),/MinerU Key 已配置/u);
});
test('empty textbook library finishes loading without repeatedly replacing the upload control',async()=>{
 const a=setup();a.run(`state.page='textbooks';root.querySelector=()=>null;
  globalThis.libraryRequests=0;globalThis.libraryRenders=0;
  textbookApi=async()=>{if(++libraryRequests>2)return new Promise(()=>{});return{books:[]}};
  render=()=>{libraryRenders++;bindTextbookLibrary()};bindTextbookLibrary();`);
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(a.run('libraryRequests'),1);assert.equal(a.run('libraryRenders'),1);
 a.run('bindTextbookLibrary()');await new Promise(resolve=>setImmediate(resolve));
 assert.equal(a.run('libraryRequests'),1);
});
test('textbook library connection failure is visible and does not enter a retry loop',async()=>{
 const a=setup();a.run(`state.page='textbooks';root.querySelector=()=>null;
  globalThis.libraryRequests=0;textbookApi=async()=>{if(++libraryRequests>2)return new Promise(()=>{});throw new Error('服务暂不可用')};
  render=()=>bindTextbookLibrary();bindTextbookLibrary();`);
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(a.run('libraryRequests'),1);assert.match(a.run('textbookError'),/服务暂不可用/u);
 assert.match(a.run('textbookLibraryPage()'),/data-textbook-refresh/u);
});
test('answer analysis sends exact structured question context and records mode and sources',async()=>{
 const a=setup();a.run(`state.sessions=[{id:'exam',title:'试卷',subject:'数学',questions:[{number:'1',question:'一元方程',studentAnswer:'x=3',correctAnswer:'x=2',status:'错误',source:'AI 推导',explanation:'移项符号错误'}]}];state.chats=[{id:'chat-1',title:'第 1 题讲解',questionContext:{questionId:'exam:question:0'},tutoringMode:'answer_analysis',modelChoice:{provider:'siliconflow',model:'chat'},messages:[]}];state.activeChatId='chat-1';composerDraft='为什么错了？';
  canUseChatModel=()=>true;currentChatModelChoice=()=>({provider:'siliconflow',model:'chat'});render=()=>{};retrieveContext=async()=>{throw new Error('答案模式不得调用 RAG')};runKnowledgeAgent=async()=>{throw new Error('答案模式不得调用知识检索 Agent')};
  streamChat=async(body,signal,onToken)=>{globalThis.answerTurnBody=body;onToken('逐步解析')};`);
 await a.run('sendChat()');
 assert.match(a.run("answerTurnBody.messages[0].content"),/exam:question:0/);assert.match(a.run("answerTurnBody.messages[0].content"),/x=2/);assert.match(a.run("answerTurnBody.messages[0].content"),/AI 推导/);
 assert.match(a.run("answerTurnBody.messages[0].content"),/参考资料相冲突/);assert.match(a.run("answerTurnBody.messages[0].content"),/其他模式的模型回答只是对话记录/);
 assert.equal(a.run("activeChat().messages.at(-2).mode"),'answer_analysis');assert.equal(a.run("activeChat().messages.at(-1).mode"),'answer_analysis');assert.equal(a.run("activeChat().messages.at(-1).conversationId"),'chat-1');assert.equal(a.run("activeChat().messages.at(-1).sourceRefs.length"),1);assert.equal(a.run("activeChat().messages.at(-1).sourceStatus"),'question_record');
});
test('lecture mode searches existing knowledge sources and saves returned citations',async()=>{
 const a=setup();a.run(`state.sessions=[{id:'exam',title:'试卷',questions:[{number:'1',question:'位移与路程的区别',studentAnswer:'二者相同',status:'错误'}]}];state.sources=[{id:'lecture-1',name:'运动学讲义',chunks:[{id:'p4',text:'位移是位置变化量，路程是运动轨迹长度。'}]}];state.selectedSourceIds=[];state.chats=[{id:'chat-2',title:'讲题',questionContext:{questionId:'exam:question:0'},tutoringMode:'lecture',modelChoice:{provider:'siliconflow',model:'chat'},messages:[]}];state.activeChatId='chat-2';composerDraft='这两个量有什么区别？';
  canUseChatModel=()=>true;currentChatModelChoice=()=>({provider:'siliconflow',model:'chat'});render=()=>{};notify=message=>{globalThis.lectureError=message};retrieveContext=async(query,sourceIds)=>{globalThis.lectureQuery=query;globalThis.lectureIds=sourceIds;return[{source:'运动学讲义',sourceId:'lecture-1',chunkId:'p4',pageNumber:4,headingPath:['运动学','位移'],text:'位移是位置变化量，路程是运动轨迹长度。'}]};
  runKnowledgeAgent=async options=>{globalThis.agentMode=options.mode;options.onTrace({type:'search',label:'补充检索',results:options.initialRefs});return'系统讲解'};`);
 await a.run('sendChat()');
 assert.equal(a.run('globalThis.lectureError||""'),'');assert.equal(a.run('agentMode'),'lecture');assert.deepEqual(Array.from(a.run('lectureIds')),['lecture-1']);assert.match(a.run('lectureQuery'),/位移与路程的区别/);assert.match(a.run('lectureQuery'),/二者相同/);
 assert.equal(a.run("activeChat().messages.at(-1).mode"),'lecture');assert.equal(a.run("activeChat().messages.at(-1).sourceRefs[0].source"),'运动学讲义');assert.equal(a.run("activeChat().messages.at(-1).sourceRefs[0].pageNumber"),4);
});
test('lecture mode stops when the stable question record cannot be resolved',async()=>{
 const a=setup();a.run(`state.sources=[{id:'lecture-1',name:'运动学讲义',chunks:[{id:'p4',text:'讲义内容'}]}];state.chats=[{id:'chat-3',title:'讲题',questionContext:{questionId:'missing:question:0'},tutoringMode:'lecture',modelChoice:{provider:'siliconflow',model:'chat'},messages:[]}];state.activeChatId='chat-3';composerDraft='请讲这道题';
  canUseChatModel=()=>true;currentChatModelChoice=()=>({provider:'siliconflow',model:'chat'});render=()=>{};retrieveContext=async()=>{throw new Error('缺少题目时不得检索')};runKnowledgeAgent=async()=>{throw new Error('缺少题目时不得调用 agent')};`);
 await a.run('sendChat()');assert.equal(a.run("activeChat().messages.at(-1).sourceStatus"),'missing_question');assert.match(a.run("activeChat().messages.at(-1).content"),/无法确定要讲解的题目/);
});
test('library filtering distinguishes usable, failed and stale-structure documents',()=>{const a=setup();a.run("state.sources=[{id:'a',name:'ready',chunks:[{text:'hello'}],structureVersion:1,processingStatus:'done'},{id:'b',name:'failed',processingError:'offline',chunks:[]},{id:'c',name:'stale',chunks:[{text:'old'}],processingStatus:'done'}];libraryFilter='attention'");assert.match(a.run('libraryRows()'),/failed/);assert.match(a.run('libraryRows()'),/stale/);assert.doesNotMatch(a.run('libraryRows()'),/>ready</);a.run("libraryFilter='ready'");assert.match(a.run('libraryRows()'),/>ready</);assert.doesNotMatch(a.run('libraryRows()'),/>failed<|>stale</)});

test('grading job resumes from saved OCR and completed questions after a question failure',async()=>{
 const a=setup();for(const [id,value]of Object.entries({'grade-title':'两题练习','grade-subject':'数学','grading-focus':'','grade-source':'','grade-status':''}))a.field(id,value);
 a.run(`
  state.page='grade';state.sources=[];state.sessions=[];selectedPhotos=['photo-data'];
  hasApiKey=()=>true;render=()=>{};saveGradingPhotos=async()=>{};deleteGradingPhotos=async()=>{};
  globalThis.gradeCalls={A:0,B:0};
  callChat=async body=>{
   if(body.model===state.settings.visionModel)return{choices:[{message:{content:JSON.stringify({questions:[{number:'1',question:'题目 A',studentAnswer:'作答 A'},{number:'2',question:'题目 B',studentAnswer:'作答 B'}]})}}]};
   const prompt=body.messages.at(-1).content||'';const key=prompt.includes('题目：\\n题目 A')?'A':'B';gradeCalls[key]++;
   if(key==='B'&&gradeCalls.B===1)throw new Error('临时网络错误');
   return{choices:[{message:{content:JSON.stringify({status:'正确',score:1,maxScore:1,correctAnswer:'答案',explanation:'依据',source:'AI 推导'})}}]};
  };
 `);
 await a.run('gradePhotos(false)');
 assert.equal(a.run("state.gradingJob.status"),'failed');assert.equal(a.run("Object.keys(state.gradingJob.results).length"),1);assert.equal(a.run("Object.keys(state.gradingJob.pages).length"),1);assert.equal(a.run("lastSaved.gradingJob.images"),undefined);
 await a.run('gradePhotos(true)');
 assert.equal(a.run('state.gradingJob'),null);assert.equal(a.run('state.sessions.length'),1);assert.equal(a.run('state.sessions[0].questions.length'),2);assert.equal(a.run('gradeCalls.A'),1);assert.equal(a.run('gradeCalls.B'),2);
});

test('grading leaves an uncertain student answer pending instead of asking the model to guess',async()=>{
 const a=setup();for(const [id,value]of Object.entries({'grade-title':'识别练习','grade-subject':'数学','grading-focus':'','grade-source':'','grade-status':''}))a.field(id,value);
 a.run(`state.page='grade';state.sources=[];state.sessions=[];selectedPhotos=['photo-data'];hasApiKey=()=>true;render=()=>{};saveGradingPhotos=async()=>{};deleteGradingPhotos=async()=>{};globalThis.gradingModelCalls=0;fetch=async()=>({ok:true,json:async()=>({status:'none'})});callChat=async body=>{if(body.model===state.settings.visionModel)return{choices:[{message:{content:JSON.stringify({questions:[{number:'1',question:'一道题目',studentAnswer:'[无法辨认]'}]})}}]};gradingModelCalls++;throw new Error('模糊答案不应进入评分模型')};`);
 await a.run('gradePhotos(false)');
 assert.equal(a.run('gradingModelCalls'),0);
 assert.equal(a.run("state.sessions[0].questions[0].status"),'待确认');
 assert.equal(a.run('state.sessions[0].questions[0].score'),null);
 assert.match(a.run("state.sessions[0].questions[0].explanation"),/暂不判定对错/u);
});

test('ambiguous textbook matches are recorded and are never presented as an official answer',async()=>{
 const a=setup();for(const [id,value]of Object.entries({'grade-title':'同题多版本','grade-subject':'数学','grading-focus':'','grade-source':'','grade-status':''}))a.field(id,value);
 a.run(`state.page='grade';state.sources=[];state.sessions=[];selectedPhotos=['photo-data'];hasApiKey=()=>true;render=()=>{};saveGradingPhotos=async()=>{};deleteGradingPhotos=async()=>{};globalThis.gradePrompt='';fetch=async()=>({ok:true,json:async()=>({status:'ambiguous',candidates:[{bookId:'b1',bookTitle:'版本甲',questionId:'q1'},{bookId:'b2',bookTitle:'版本乙',questionId:'q2'}]})});completeQuestionFromKnowledge=async({item})=>item;retrieveContext=async()=>[];callChat=async body=>{if(body.model===state.settings.visionModel)return{choices:[{message:{content:JSON.stringify({questions:[{number:'1',question:'一道题目',studentAnswer:'A'}]})}}]};gradePrompt=body.messages.map(message=>message.content||'').join('\\n');return{choices:[{message:{content:JSON.stringify({status:'正确',score:1,maxScore:1,correctAnswer:'A',explanation:'模型判断',source:'AI 推导'})}}]}};`);
 await a.run('gradePhotos(false)');
 assert.match(a.run('gradePrompt'),/多条题干完全匹配/u);
 assert.equal(a.run("state.sessions[0].questions[0].textbookMatchStatus"),'ambiguous');
 assert.equal(a.run("state.sessions[0].questions[0].textbookRecord"),undefined);
 assert.match(a.run('questionDetailMarkup(state.sessions[0],state.sessions[0].questions[0],0)'),/AI 推理参考/u);
});

test('grading agent uses the knowledge tool loop to request and then apply evidence',async()=>{
 const a=setup();a.run(`state.sources=[{id:'book',name:'课程讲义',chunks:[]}];state.settings.chatModel='chat-model';retrieveContext=async()=>[{source:'课程讲义',sourceId:'book',chunkId:'p1',pageNumber:1,text:'定理：两边平方和关系'}];globalThis.agentCalls=[];callChat=async body=>{if(body.messages[0].content===completionSystemPrompt)return{choices:[{message:{content:JSON.stringify({status:"unchanged",reason:"题面完整",patches:[]})}}]};agentCalls.push(body);if(agentCalls.length===1)return{choices:[{message:{content:null,tool_calls:[{id:'tool-1',function:{name:'search_knowledge',arguments:JSON.stringify({query:'两边平方和关系',source_name:'课程讲义'})}}]}}]};return{choices:[{message:{content:JSON.stringify({status:'正确',score:1,maxScore:1,correctAnswer:'答案',explanation:'符合讲义定理',source:'课程讲义',confidence:'高'})}}]}}`);
 const result=await a.run("runGradingAgent({item:{number:'1',question:'应用定理',studentAnswer:'作答'},subject:'数学',focus:'',sourceId:'book',signal:new AbortController().signal,onStatus:()=>{}})");
 assert.equal(a.run('agentCalls.length'),2);assert.equal(result.references.length,1);assert.equal(result.references[0].source,'课程讲义');assert.equal(result.result.status,'正确');assert.match(a.run("agentCalls[1].messages.at(-1).content"),/定理/);
});

test('cancelling grading saves completed questions and resumes the unfinished question',async()=>{
 const a=setup();for(const [id,value]of Object.entries({'grade-title':'两题练习','grade-subject':'数学','grading-focus':'','grade-source':'','grade-status':''}))a.field(id,value);
 a.run(`
  state.page='grade';state.sources=[];state.sessions=[];selectedPhotos=['photo-data'];
  hasApiKey=()=>true;render=()=>{};saveGradingPhotos=async()=>{};deleteGradingPhotos=async()=>{};
  globalThis.holdQuestionA=true;globalThis.gradeCalls={A:0,B:0};
  callChat=async(body,signal)=>{
   if(body.model===state.settings.visionModel)return{choices:[{message:{content:JSON.stringify({questions:[{number:'1',question:'题目 A',studentAnswer:'作答 A'},{number:'2',question:'题目 B',studentAnswer:'作答 B'}]})}}]};
   const prompt=body.messages.at(-1).content||'',key=prompt.includes('题目：\\n题目 A')?'A':'B';gradeCalls[key]++;
   if(key==='A'&&holdQuestionA)return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
   return{choices:[{message:{content:JSON.stringify({status:'正确',score:1,maxScore:1,correctAnswer:'答案',explanation:'依据',source:'AI 推导'})}}]};
  };
 `);
 const running=a.run('gradePhotos(false)');let saved=false;
 for(let i=0;i<100;i++){if(a.run("Boolean(state.gradingJob?.results['0:1'])")){saved=true;break}await new Promise(resolve=>setTimeout(resolve,1))}
 assert.equal(saved,true,'the fast question should be persisted before cancellation');
 await a.run('cancelGrading()');await running;
 assert.equal(a.run('state.gradingJob.status'),'cancelled');assert.equal(a.run("Object.keys(state.gradingJob.results).length"),1);
 a.run('holdQuestionA=false');await a.run('gradePhotos(true)');
 assert.equal(a.run('state.gradingJob'),null);assert.equal(a.run('state.sessions[0].questions.length'),2);assert.equal(a.run('gradeCalls.A'),2);assert.equal(a.run('gradeCalls.B'),1);
});

test('grading requests time out and question workers stay within the configured concurrency limit',async()=>{
 const a=setup();
 await assert.rejects(a.run("withGradingTimeout(signal=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason))),new AbortController().signal,'测试请求',1000)"),/超过 1 秒/);
 a.run('globalThis.activeGradeWorkers=0;globalThis.maxGradeWorkers=0');
 await a.run("runBoundedGrading([0,1,2,3,4],GRADING_QUESTION_CONCURRENCY,async()=>{activeGradeWorkers++;maxGradeWorkers=Math.max(maxGradeWorkers,activeGradeWorkers);await new Promise(resolve=>setTimeout(resolve,2));activeGradeWorkers--},new AbortController().signal)");
 assert.equal(a.run('maxGradeWorkers'),2);
});
