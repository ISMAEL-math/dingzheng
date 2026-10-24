import {createServerStorage,encodeStoredValue,storageRequest,localMigrationDecision} from './server-storage.js';
const status=document.createElement('div');status.id='service-status';document.body.append(status);
function message(text){status.textContent=text}
async function login(){
 const overlay=document.createElement('div');overlay.className='login-overlay';
 overlay.innerHTML='<form class="login-card"><h1>登录钉正</h1><p>邀请内测账号由管理员创建。</p><label>用户名<input name="username" autocomplete="username" required maxlength="80"></label><label>密码<input name="password" type="password" autocomplete="current-password" required maxlength="256"></label><button type="submit">登录</button><p role="alert"></p></form>';
 document.body.append(overlay);
 await new Promise(resolve=>{const form=overlay.querySelector('form');form.onsubmit=async e=>{e.preventDefault();const button=form.querySelector('button');button.disabled=true;try{const fields=new FormData(form);await storageRequest('/api/auth/login',{method:'POST',body:JSON.stringify({username:fields.get('username'),password:fields.get('password')})});resolve()}catch(e){form.querySelector('[role=alert]').textContent=e.message}finally{button.disabled=false}}});overlay.remove();
}
async function migrateLocal(revision){
 const existing=await storageRequest('/api/storage/entry?store=workspace&key=state');
 // Migration only runs in local mode; a hosted account never reads another user's browser data.
 const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('zhicuo-workspace');r.onupgradeneeded=()=>{};r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
 try{
  if(!db.objectStoreNames.contains('workspace'))return revision;
  const read=(store,key)=>new Promise((resolve,reject)=>{const r=db.transaction(store).objectStore(store).get(key);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
  const state=await read('workspace','state');if(!state)return revision;
  const decision=localMigrationDecision(state,existing.value,localStorage.getItem('dingzheng-local-migrated')==='yes');
  if(decision==='none')return revision;
  if(decision==='confirm'){
   const useRemote=confirm('服务端已有学习记录，此浏览器也有旧记录。为避免覆盖，本次不会自动合并。继续使用服务端记录？旧浏览器记录仍保留；取消可暂不启动并先安排迁移。');
   if(!useRemote)throw new Error('已暂停迁移：两份记录均已保留');
   localStorage.setItem('dingzheng-local-migrated','yes');return revision;
  }
  message('正在把本机学习数据和 PDF 迁到服务端；原浏览器数据保留…');
  if(db.objectStoreNames.contains('pdfFiles')){
   const keys=await new Promise((resolve,reject)=>{const r=db.transaction('pdfFiles').objectStore('pdfFiles').getAllKeys();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
   for(const key of keys){const result=await storageRequest('/api/storage/transaction',{method:'POST',body:JSON.stringify({revision,operations:[{type:'put',store:'pdfFiles',key,value:await encodeStoredValue(await read('pdfFiles',key))}]})});revision=result.revision}
  }
  const result=await storageRequest('/api/storage/transaction',{method:'POST',body:JSON.stringify({revision,operations:[{type:'put',store:'workspace',key:'state',value:await encodeStoredValue(state)}]})});localStorage.setItem('dingzheng-local-migrated','yes');return result.revision;
 }finally{db.close()}
}
try{
 let session=await storageRequest('/api/auth/session');
 if(!session.user){await login();session=await storageRequest('/api/auth/session')}
 window.dingzhengSession=session;
 const originalFetch=window.fetch.bind(window);
 window.fetch=(input,init={})=>{
  const url=new URL(typeof input==='string'||input instanceof URL?input:input.url,location.href);
  if(url.origin===location.origin&&url.pathname.startsWith('/api/')){const headers=new Headers(init.headers||(input instanceof Request?input.headers:undefined));headers.set('X-Workspace-User',session.user.id);return originalFetch(input,{...init,headers})}
  return originalFetch(input,init);
 };
 let {revision}=await storageRequest('/api/storage/meta');
 if(session.mode==='local')revision=await migrateLocal(revision);
 window.dingzhengStorage=createServerStorage(revision);
 window.dingzhengSession=session;
 message(`${session.mode==='hosted'?session.user.username:'本机'} · ${session.version} · 服务端保存`);
 if(session.mode==='hosted'){const button=document.createElement('button');button.textContent='退出登录';button.onclick=async()=>{if(!confirm('请先完成当前操作。退出登录？'))return;await storageRequest('/api/auth/logout',{method:'POST',body:'{}'});location.reload()};status.append(button)}
 await import('./app.js');
}catch(error){message(`启动失败：${error.message}。原数据未删除，请刷新重试。`)}
