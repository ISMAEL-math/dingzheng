import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=(await readFile(new URL('../public/pdf-workspace.js',import.meta.url),'utf8')).replace(/^import .*\n/,'').replace('export function','function');
function setup({failPage=0,failStorage=false,failEmbedding=false}={}){
 const elements=new Map(),snapshots=[],calls=[],notices=[];
 const element=id=>{if(!elements.has(id))elements.set(id,{value:'',textContent:'',innerHTML:'',hidden:false});return elements.get(id)};
 const document={getElementById:element,querySelector:s=>element(s.replace(/^#/,''))};
 const s={id:'s',pdfVersion:1,name:'扫描资料',pageCount:3,pages:[1,2,3].map(number=>({number,status:'pending',rotation:0,text:''})),chunks:[]};
 let failing=failPage;
 const state={sources:[s],page:'library',settings:{ocrModel:'ocr',embeddingModel:'embed'}};
 const hooks={esc:String,state:()=>state,render(){},notify:m=>notices.push(m),splitChunks:t=>t?[{text:t}]:[],formatBytes:String,hasKey:()=>true,file:async()=>({size:100}),save:async()=>{if(failStorage)throw new Error('quota');snapshots.push(structuredClone(s))},embed:async items=>{if(failEmbedding)throw new Error('embedding offline');return items.map(()=>[1,0])},chat:async(body,signal)=>{const page=Number(body.messages[0].content[0].image_url.url);calls.push(page);if(page===failing)throw new Error('network failed');signal.throwIfAborted();return {text:`第${page}页文字`}},contentText:r=>r.text};
 const ctx=vm.createContext({document,navigator:{},console,AbortSignal,AbortController,setTimeout,Blob,URL,crypto,MAX_PDF_BYTES:200*1024*1024,prompt:()=>null,confirm:()=>true,openPdf:async()=>({destroy:async()=>{}}),renderPdfPage:async(pdf,n)=>String(n),hooks});
 vm.runInContext(source+'\nglobalThis.workspace=createPdfWorkspace(hooks);',ctx);
 return {workspace:ctx.workspace,s,calls,snapshots,notices,el:element,recover:()=>failing=0};
}
async function run(a,first=1,last=3){a.el('pdf-first').value=String(first);a.el('pdf-last').value=String(last);await a.el('pdf-run').onclick();}
test('page OCR persists before a later failure and resumes without repeating successful pages',async()=>{
 const a=setup({failPage:2});await a.workspace.show(a.s);await run(a);
 assert.deepEqual(a.calls,[1,2]);assert.equal(a.s.pages[0].status,'done');assert.equal(a.s.pages[1].status,'error');
 assert.ok(a.snapshots.some(s=>s.pages[0].status==='done'&&!s.chunks[0].embedding));
 a.recover();await run(a);assert.deepEqual(a.calls,[1,2,2,3]);assert.ok(a.s.pages.every(p=>p.status==='done'));assert.equal(a.s.chunks[2].pageNumber,3);
});
test('embedding failure preserves recognized pages and lexical retrieval content',async()=>{
 const a=setup({failEmbedding:true});await a.workspace.show(a.s);await run(a);
 assert.equal(a.s.chunks.length,3);assert.ok(a.s.pages.every(p=>p.status==='done'));assert.match(a.s.pdfError,/向量/);
});
test('storage failure rolls back the page and stops before further paid calls',async()=>{
 const a=setup({failStorage:true});await a.workspace.show(a.s);await run(a);
 assert.deepEqual(a.calls,[1]);assert.equal(a.s.pages[0].status,'pending');assert.equal(a.s.chunks.length,0);assert.equal(a.workspace.busy(),false);
});
test('manual correction updates page-linked chunks and removes stale embeddings',async()=>{
 const a=setup();await a.workspace.show(a.s);await run(a,1,1);a.el('pdf-page-text').value='人工校正的答案';await a.el('pdf-save-page').onclick();
 assert.equal(a.s.pages[0].reviewed,true);assert.match(a.s.chunks[0].text,/人工校正/);assert.equal(a.s.chunks[0].embedding,undefined);
});
test('invalid ranges make no model calls and oversized PDF is rejected before opening',async()=>{
 const a=setup();await a.workspace.show(a.s);await run(a,0,999);assert.equal(a.calls.length,0);
 await a.workspace.ingest({size:200*1024*1024+1});assert.match(a.notices.at(-1),/200 MB/);
});
