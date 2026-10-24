export async function encodeStoredValue(value){
 if(typeof Blob!=='undefined'&&value instanceof Blob){const bytes=new Uint8Array(await value.arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode(...bytes.subarray(i,i+32768));return{format:'file',name:value.name||'document.pdf',type:value.type,lastModified:value.lastModified||0,data:btoa(binary)}}
 return{format:'json',data:structuredClone(value)};
}
export function decodeStoredValue(value){if(!value)return undefined;if(value.format==='file'){const bytes=Uint8Array.from(atob(value.data),c=>c.charCodeAt(0));return new File([bytes],value.name,{type:value.type,lastModified:value.lastModified})}return value.data}
export async function storageRequest(path,options={}){const response=await fetch(path,{...options,headers:{'Content-Type':'application/json','X-Dingzheng-Client':'1',...options.headers},cache:'no-store'});const data=await response.json();if(!response.ok)throw Object.assign(new Error(data.error?.message||'保存失败'),{status:response.status});return data}
// Implements the small transaction subset used by the existing workspace UI.
// Writes are serialized and CAS-protected; a stale device must reload, never overwrite.
export function createServerStorage(initialRevision,request=storageRequest){
 let revision=initialRevision,queue=Promise.resolve();
 return{transaction(stores,mode='readonly'){
  const names=Array.isArray(stores)?stores:[stores],operations=[],requests=[];
  const tx={error:null,objectStore(store){if(!names.includes(store))throw new Error('未声明的数据表');return{
   put(value,key){operations.push({type:'put',store,key,value:encodeStoredValue(value)})},delete(key){operations.push({type:'delete',store,key})},clear(){operations.push({type:'clear',store})},
   get(key){const req={result:undefined,error:null};requests.push({req,store,key});return req}
  }}};
  queueMicrotask(()=>{
   const run=async()=>{
    try{
     if(operations.length){if(mode!=='readwrite')throw new Error('只读事务不能写入');const ops=await Promise.all(operations.map(async op=>({...op,...(op.type==='put'?{value:await op.value}:{})})));const result=await request('/api/storage/transaction',{method:'POST',body:JSON.stringify({revision,operations:ops})});revision=result.revision}
     for(const {req,store,key} of requests){const result=await request(`/api/storage/entry?store=${encodeURIComponent(store)}&key=${encodeURIComponent(key)}`);req.result=decodeStoredValue(result.value);req.onsuccess?.()}
     tx.oncomplete?.();
    }catch(error){tx.error=error;for(const {req}of requests){req.error=error;req.onerror?.()}tx.onerror?.();tx.onabort?.()}
   };
   queue=queue.then(run,run);
  });
  return tx;
 }};
}

export function localMigrationDecision(localState,serverValue,alreadyMigrated){
 if(!localState)return 'none';
 const hasStudyData=value=>['sources','sessions','mistakes','chats','notebooks','subjects','tags'].some(key=>Array.isArray(value?.[key])&&value[key].length);
 if(!serverValue||(hasStudyData(localState)&&!hasStudyData(serverValue.data)))return 'migrate';
 return alreadyMigrated?'none':'confirm';
}
