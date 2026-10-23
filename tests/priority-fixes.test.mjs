import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import * as questionModel from '../public/question-model.js';
import * as chatModels from '../public/chat-models.mjs';
import * as questionCompletion from '../public/question-completion.js';
import * as questionPresentation from '../public/question-presentation.js';
import * as ragStructure from '../public/rag-structure.js';
import { normalizeNotebooks, collectQuestions } from '../public/notebook-model.js';
import { createNotebookUI } from '../public/notebook-ui.js';
import { createPaperUI } from '../public/paper-ui.js';
import { withGlobalStyle } from '../public/response-style.js';

const source=(await readFile(new URL('../public/app.js',import.meta.url),'utf8')).replace(/^import .*\n/gm,'').replace(/await Promise\.all\(\[load\(\),loadServerConfig\(\),refreshCodexStatus\(\)\]\);state=normalizeNotebooks\(state\);render\(\);/,'');
function app({serverKey=true,fail=false,configFails=false}={}){
  const elements=new Map(),calls=[];
  const element=selector=>{
    if(!elements.has(selector))elements.set(selector,{value:'',textContent:'',innerHTML:'',hidden:false,disabled:false,scrollTop:0,scrollHeight:0,clientHeight:0,isConnected:true,
      classList:{add(){},remove(){},toggle(){},contains:()=>false},
      querySelector:sel=>element(selector+' '+sel),querySelectorAll(){return[]},addEventListener(){},removeEventListener(){},
      setAttribute(){},getAttribute(){return null},focus(){},click(){}});
    return elements.get(selector);
  };
  const context=vm.createContext({...questionModel,...chatModels,...questionCompletion,...questionPresentation,...ragStructure,
    normalizeNotebooks,collectQuestions,createNotebookUI,createPaperUI,withGlobalStyle,
    renderChatMarkdown:x=>x,structuredClone,DOMException,TextDecoder,
    console,AbortSignal,AbortController,crypto:{randomUUID},setTimeout,clearTimeout,requestAnimationFrame:fn=>fn(),
    window:{matchMedia:()=>({matches:true,addEventListener(){}}),scrollTo(){}},
    indexedDB:{open(){return{}}},
    document:{body:element('body'),querySelector:element,querySelectorAll(){return[]},addEventListener(){},createElement:()=>element('#created')},
    fetch:async(path,options={})=>{
      calls.push({path,options});
      if(path==='/api/config'){
        if(configFails)throw new Error('offline');
        return{ok:true,json:async()=>({hasServerKey:serverKey})};
      }
      if(fail)return{ok:false,status:401,text:async()=>JSON.stringify({error:{message:'invalid key'}}),json:async()=>({error:{message:'invalid key'}}),headers:{get:()=>'application/json'},body:{}};
      if(path==='/api/embeddings')return{ok:true,json:async()=>({data:[{index:0,embedding:[1,0]}]}),headers:{get:()=>'application/json'},body:{}};
      return{ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({questions:[{number:'1',question:'1+1',status:'正确'}],status:'正确'}),finish_reason:'stop'}}]}),text:async()=>'',headers:{get:()=>'application/json'},body:{}};
    }
  });
  vm.runInContext(source,context);
  vm.runInContext("save=async()=>{};render=()=>{};notify=message=>{globalThis.notice=message};saveGradingPhotos=async()=>{};deleteGradingPhotos=async()=>{};loadGradingPhotos=async()=>[];",context);
  return{run:code=>vm.runInContext(code,context),element,calls};
}
const click=el=>el.onclick({currentTarget:el});

test('server-only key permits chat, photo grading and practice without browser Authorization',async()=>{
  const a=app();
  await a.run('loadServerConfig()');
  assert.equal(a.run('hasApiKey()'),true);
  assert.match(a.run('settingsPage()'),/已配置服务端 Key/);
  await a.run("composerDraft='hello';sendChat()");
  assert.equal(a.run('state.chats[0].messages.length'),2);
  await a.run("selectedPhotos=['data:image/jpeg;base64,test'];gradePhotos()");
  assert.equal(a.run('state.sessions.length'),1);
  await a.run("practice={items:[{id:'q',question:'1+1',correctAnswer:'2'}],answers:{q:'2'}};finishPractice()");
  assert.equal(a.run('practice'),null);
  const requests=a.calls.filter(c=>c.path!=='/api/config');
  assert.ok(requests.length>=3);
  assert.ok(requests.every(c=>!('Authorization' in c.options.headers)));
});
test('no configured key blocks chat and grading',async()=>{
  const a=app({serverKey:false});
  await a.run('loadServerConfig()');
  assert.equal(a.run('hasApiKey()'),false);
  await a.run("composerDraft='hello';sendChat()");
  await a.run("selectedPhotos=['photo'];gradePhotos()");
  assert.equal(a.run('state.page'),'settings');
  assert.equal(a.calls.length,1);
});
test('browser key takes precedence for chat and embeddings',async()=>{
  const a=app();
  await a.run('loadServerConfig()');
  await a.run("state.settings.apiKey=' browser-key ';callChat({})");
  await a.run("embeddings(['text'])");
  assert.ok(a.calls.slice(1).every(c=>c.options.headers.Authorization==='Bearer browser-key'));
});
for(const fail of [false,true])test(`connection check preserves saved key on ${fail?'failure':'success'}`,async()=>{
  const a=app({fail});
  a.run("state.settings.apiKey='saved-key';bindSettings()");
  a.element('#api-key').value='candidate-key';
  await click(a.element('#check-api'));
  assert.equal(a.run('state.settings.apiKey'),'saved-key');
  assert.equal(a.calls.at(-1).options.headers.Authorization,'Bearer candidate-key');
  assert.match(a.element('#key-status').textContent,fail?/连接失败/:/连接成功/);
});
test('blank connection-check field uses server key without replacing saved browser key',async()=>{
  const a=app();
  a.run("state.settings.apiKey='saved-key';bindSettings()");
  await click(a.element('#check-api'));
  assert.equal(a.calls.at(-1).options.headers.Authorization,undefined);
  assert.equal(a.run('state.settings.apiKey'),'saved-key');
});
test('config lookup failure does not incorrectly block a server-backed request',async()=>{
  const a=app({configFails:true});
  await a.run('loadServerConfig()');
  assert.match(a.run('keyStatus()'),/无法读取服务端配置/);
  await a.run("composerDraft='hello';sendChat()");
  assert.equal(a.run('state.chats[0].messages.length'),2);
});
test('retrieval ranks all chunks, including a relevant vector after the first eight',async()=>{
 const a=app();
 a.run("state.sources=[{id:'s',name:'资料',embeddingModel:state.settings.embeddingModel,chunks:Array.from({length:12},(_,i)=>({id:i,text:'different',embedding:i===11?[1,0]:[0,1]}))}]");
 const matches=await a.run("retrieveContext('target','s')");
 assert.equal(matches.length,1);assert.equal(matches[0].chunkId,11);
});
test('retrieval respects source selection and rejects unrelated or incompatible vectors',async()=>{
 const a=app();
 a.run("state.sources=[{id:'a',name:'a',embeddingModel:'old',chunks:[{id:0,text:'different',embedding:[1,0]}]},{id:'b',name:'b',embeddingModel:state.settings.embeddingModel,chunks:[{id:0,text:'target',embedding:[1,0]}]}]");
 assert.equal((await a.run("retrieveContext('target','a')")).length,0);
 assert.equal((await a.run("retrieveContext('target','b')"))[0].sourceId,'b');
});
test('text fallback retrieves Chinese content without embeddings',async()=>{
 const a=app({fail:true});
 a.run("state.sources=[{id:'s',name:'资料',chunks:[{text:'二叉树遍历的顺序'},{text:'天气晴朗'}]}]");
 assert.equal((await a.run("retrieveContext('二叉树遍历','s')"))[0].text,'二叉树遍历的顺序');
});
test('multi-photo grading assigns page indices and shows all photos',async()=>{
 const a=app();
 await a.run("selectedPhotos=['data:image/jpeg;base64,YQ==','data:image/jpeg;base64,Yg=='];gradePhotos()");
 assert.equal(a.run('state.sessions[0].questions[1].imageIndex'),1);
 assert.equal(a.run('questionImage(state.sessions[0],state.sessions[0].questions[1])'),'data:image/jpeg;base64,Yg==');
 assert.match(a.run('resultPage()'),/YQ==/);
 a.run('currentResultQuestionIndex=1');
 assert.match(a.run('resultPage()'),/Yg==/);
});
test('manual corrections synchronize collected mistakes and survive persistence failure atomically',async()=>{
 const a=app();
 a.run("state.sessions=[{id:'s',images:['one','two'],questions:[{question:'old',status:'错误',imageIndex:0}]}];state.mistakes=[{id:'m',sourceSessionId:'s',questionIndex:0,status:'待复习'}]");
 await a.run("updateQuestion('s',0,{question:'new',studentAnswer:'2',correctAnswer:'2',explanation:'fixed',status:'正确',imageIndex:1,cropImage:''})");
 assert.equal(a.run('questionImage(state.sessions[0],state.sessions[0].questions[0])'),'two');assert.equal(a.run('state.mistakes[0].question'),'new');assert.equal(a.run('state.mistakes[0].status'),'已掌握');
 a.run("save=async()=>{throw new Error('quota')}");
 await assert.rejects(a.run("updateQuestion('s',0,{question:'lost',status:'错误',imageIndex:0})"),/quota/);
 assert.equal(a.run('state.sessions[0].questions[0].question'),'new');
});
test('image history keeps vision model for follow-up, including explicit text-model selection',async()=>{
 const a=app();
 await a.run("pendingChatPhotos=['data:image/jpeg;base64,YQ=='];composerDraft='看题';sendChat()");
 await a.run("activeChatModel='chat';composerDraft='为什么';sendChat()");
 const request=JSON.parse(a.calls.at(-1).options.body);
 assert.equal(request.model,a.run('state.settings.visionModel'));
 assert.ok(request.messages.some(m=>Array.isArray(m.content)));
});
test('new and legacy backups restore data while preserving local credentials',async()=>{
 const a=app();
 a.run("state.settings.apiKey='local';globalThis.backup={sources:[],sessions:[],mistakes:[],chats:[{id:'c',title:'恢复对话',messages:[{role:'user',content:'hello'}]}],settings:{apiKey:'external'}}");
 assert.equal(a.run('validateBackup(backup).chats.length'),1);
 await a.run("restoreBackup({format:'dingzheng-backup',version:1,data:backup})");
 assert.equal(a.run('state.settings.apiKey'),'local');assert.equal(a.run('state.chats[0].title'),'恢复对话');
});
test('invalid backup, unsafe image, duplicate IDs and failed storage leave current data intact',async()=>{
 const a=app();
 a.run("globalThis.backup={sources:[],sessions:[],mistakes:[],chats:[]};state.chats=[{id:'keep'}]");
 assert.throws(()=>a.run("validateBackup({format:'dingzheng-backup',version:2,data:backup})"),/版本/);
 assert.throws(()=>a.run("validateBackup({...backup,chats:[{id:'x',messages:[]},{id:'x',messages:[]}]})"),/重复/);
 assert.throws(()=>a.run("validateBackup({...backup,mistakes:[{id:'x',image:'x\" onerror=\"alert(1)'}]})"),/图片/);
 a.run("save=async()=>{throw new Error('quota')}");await assert.rejects(a.run('restoreBackup(backup)'),/quota/);
 assert.equal(a.run('state.chats[0].id'),'keep');
});
test('legacy multi-page mistakes do not silently retain the first photo',()=>{
 const a=app();
 a.run("globalThis.data=normalizePhotoLinks({sessions:[{id:'s',images:['page1','page2'],questions:[{question:'old'}]}],mistakes:[{sourceSessionId:'s',questionIndex:0,image:'page1'}]})");
 assert.equal(a.run('data.sessions[0].questions[0].imageIndex'),null);
 assert.equal(a.run('questionImage(data.sessions[0],data.sessions[0].questions[0])'),'');
});
test('legacy single-page backups recover their photo link',()=>{
 const a=app();
 a.run("globalThis.data=validateBackup({sources:[],sessions:[{id:'s',images:['data:image/png;base64,YQ=='],questions:[{number:1,question:'old',status:'错误'}]}],mistakes:[{id:'m',sourceSessionId:'s',questionIndex:0}]})");
 assert.equal(a.run('data.sessions[0].questions[0].imageIndex'),0);
 assert.equal(a.run('questionImage(data.sessions[0],data.sessions[0].questions[0])'),'data:image/png;base64,YQ==');
 assert.equal(a.run('data.sessions[0].questions[0].number'),'1');
});
