import { questionType, questionGroup, questionFigures, normalizeParts, questionSignature, needsQuestionReview, QUESTION_TYPES } from './question-model.js';

const clean=(value,max=120)=>typeof value==='string'?value.trim().slice(0,max):'';
export const splitTags=value=>[...new Set((Array.isArray(value)?value:typeof value==='string'?value.split(/[,，、\n]/):[]).map(tag=>clean(tag,30)).filter(Boolean))].slice(0,30);
export function normalizeNotebooks(data,makeId=()=>crypto.randomUUID()){
 const subjects=[...new Set((Array.isArray(data.subjects)?data.subjects:[]).map(value=>clean(value,60)).filter(Boolean))];
 const seen=new Set();const notebooks=(Array.isArray(data.notebooks)?data.notebooks:[]).filter(book=>book&&typeof book.id==='string'&&/^[\w-]{1,100}$/.test(book.id)&&clean(book.name)&&clean(book.subject,60)&&!seen.has(book.id)&&seen.add(book.id)).map(book=>({id:book.id,name:clean(book.name,80),subject:clean(book.subject,60)}));
 const tags=[...new Set((Array.isArray(data.tags)?data.tags:[]).map(value=>clean(value,30)).filter(Boolean))];
 const mistakes=(data.mistakes||[]).map(mistake=>{
  const subject=clean(mistake.subject,60)||'未分类';let book=notebooks.find(item=>item.id===mistake.notebookId);
  if(!book){book=notebooks.find(item=>item.subject===subject);if(!book){book={id:makeId(),name:subject==='未分类'?'待整理错题本':subject+'错题本',subject};notebooks.push(book)}}
  if(!subjects.includes(book.subject))subjects.push(book.subject);const ownTags=splitTags(mistake.tags||[]);for(const tag of ownTags)if(!tags.includes(tag))tags.push(tag);
  const original=data.sessions?.find(session=>session.id===mistake.sourceSessionId)?.questions?.[mistake.questionIndex];
  return {...mistake,subject:book.subject,notebookId:book.id,tags:ownTags,type:questionType({...mistake,type:mistake.type||original?.type}),figures:questionFigures(mistake.figures?mistake:original),parts:normalizeParts(mistake.parts||original?.parts)};
 });for(const book of notebooks)if(!subjects.includes(book.subject))subjects.push(book.subject);
 return {...data,subjects,notebooks,tags,mistakes};
}
export function classification(data,{subject,notebookId,name,tags=[]},makeId=()=>crypto.randomUUID()){
 const next={...data,subjects:[...(data.subjects||[])],notebooks:[...(data.notebooks||[])],tags:[...(data.tags||[])]};
 let book=next.notebooks.find(item=>item.id===notebookId);
 if(!book){subject=clean(subject,60);name=clean(name,80);if(!subject)throw new Error('请选择或填写科目');if(!name)throw new Error('请选择错题本，或填写新错题本名称');book=next.notebooks.find(item=>item.subject===subject&&item.name===name);if(!book){book={id:makeId(),name,subject};next.notebooks.push(book)}}
 if(!next.subjects.includes(book.subject))next.subjects.push(book.subject);const selectedTags=splitTags(tags);for(const tag of selectedTags)if(!next.tags.includes(tag))next.tags.push(tag);
 return {next,book,tags:selectedTags};
}
export function collectQuestions(data,sessionId,indexes,destination,makeId=()=>crypto.randomUUID()){
 const session=data.sessions.find(item=>item.id===sessionId);if(!session)throw new Error('原批改记录不存在');
 const unique=[...new Set(indexes)];if(!unique.length)throw new Error('请先选择要采集的题目');for(const index of unique)if(!Number.isInteger(index)||!session.questions[index]?.question?.trim())throw new Error('选择的题目无效');
 const missing=unique.filter(index=>!data.mistakes.some(m=>m.sourceSessionId===sessionId&&m.questionIndex===index));if(!missing.length)return {next:data,added:0};
 const {next,book,tags}=classification(data,destination,makeId);const added=missing.map(index=>{const q=session.questions[index];return {id:makeId(),sourceSessionId:sessionId,questionIndex:index,number:String(q.number||index+1),title:q.question.slice(0,65),question:q.question,type:questionType(q),figures:questionFigures(q),parts:normalizeParts(q.parts),...(q.reviewedSignature?{reviewedSignature:q.reviewedSignature}:{}),...(q.recognizedQuestion!==undefined?{recognizedQuestion:q.recognizedQuestion}:{}),...(q.questionCompletion?{questionCompletion:q.questionCompletion}:{}),studentAnswer:q.studentAnswer||'',correctAnswer:q.correctAnswer||'',explanation:q.explanation||'',source:q.source||'AI 推导',status:'待复习',subject:book.subject,notebookId:book.id,tags:[...tags],createdAt:Date.now(),gradingStatus:q.status}});
 next.mistakes=[...added,...data.mistakes];return {next,added:added.length};
}
export function filterMistakes(data,filter){const query=(filter.query||'').trim().toLowerCase();return data.mistakes.filter(m=>(!filter.subject||m.subject===filter.subject)&&(!filter.notebookId||m.notebookId===filter.notebookId)&&(!filter.group||questionGroup(m)===filter.group)&&(!filter.review||needsQuestionReview(m))&&(!filter.tag||(m.tags||[]).includes(filter.tag))&&(!filter.status||m.status===filter.status)&&(!query||[m.title,m.question,m.subject,...(m.tags||[])].join(' ').toLowerCase().includes(query)));}

export function reclassifyMistakes(data,mistakeIds,destination,makeId=()=>crypto.randomUUID()){
 const ids=new Set(mistakeIds);if(!ids.size)throw new Error('请先选择题目');for(const id of ids)if(!data.mistakes.some(m=>m.id===id))throw new Error('选择的题目已不存在');
 const result=classification(data,destination,makeId);result.next.mistakes=data.mistakes.map(m=>ids.has(m.id)?{...m,subject:result.book.subject,notebookId:result.book.id,tags:ids.size>1?splitTags([...(m.tags||[]),...result.tags]):result.tags}:m);return result.next;
}

const requiredName = (value, max = 60) => {
 const name=clean(value,max);if(!name)throw new Error('名称不能为空');return name;
};
function cleanPaper(data, mistakes) {
 return {...data,mistakes,...(data.paperDraft?{paperDraft:{...data.paperDraft,questionIds:(data.paperDraft.questionIds||[]).filter(id=>mistakes.some(m=>m.id===id))}}:{})};
}
export function removeMistakes(data, ids) {
 const selected=new Set(ids);if(!selected.size)throw new Error('请先选择题目');
 return cleanPaper(data,data.mistakes.filter(m=>!selected.has(m.id)));
}
export function renameNotebook(data, notebookId, value) {
 const book=data.notebooks.find(b=>b.id===notebookId),name=requiredName(value,80);
 if(!book)throw new Error('错题本不存在');
 if(data.notebooks.some(b=>b.id!==notebookId&&b.subject===book.subject&&b.name===name))throw new Error('该科目下已有同名错题本');
 return {...data,notebooks:data.notebooks.map(b=>b.id===notebookId?{...b,name}:b)};
}
export function removeNotebook(data, notebookId, {mode,targetNotebookId}={}) {
 const book=data.notebooks.find(b=>b.id===notebookId);if(!book)throw new Error('错题本不存在');
 const own=data.mistakes.filter(m=>m.notebookId===notebookId);
 let next=data;
 if(own.length){
  if(mode==='move'){
   const target=data.notebooks.find(b=>b.id===targetNotebookId&&b.id!==notebookId);if(!target)throw new Error('请选择接收题目的错题本');
   next={...data,mistakes:data.mistakes.map(m=>m.notebookId===notebookId?{...m,notebookId:target.id,subject:target.subject}:m)};
  }else if(mode==='delete')next=removeMistakes(data,own.map(m=>m.id));
  else throw new Error('请选择移动题目或一起删除');
 }
 return {...next,notebooks:next.notebooks.filter(b=>b.id!==notebookId)};
}
export function renameSubject(data, previous, value) {
 const name=requiredName(value);if(!data.subjects.includes(previous))throw new Error('科目不存在');
 if(name!==previous&&data.subjects.includes(name))throw new Error('已有同名科目');
 return {...data,subjects:data.subjects.map(s=>s===previous?name:s),notebooks:data.notebooks.map(b=>b.subject===previous?{...b,subject:name}:b),mistakes:data.mistakes.map(m=>m.subject===previous?{...m,subject:name}:m)};
}
export function removeSubject(data, subject, {mode,targetSubject}={}) {
 if(!data.subjects.includes(subject))throw new Error('科目不存在');
 const own=data.notebooks.filter(b=>b.subject===subject);let next=data;
 if(own.length||data.mistakes.some(m=>m.subject===subject)){
  if(mode==='move'){
   if(targetSubject===subject||!data.subjects.includes(targetSubject))throw new Error('请选择接收内容的科目');
   if(own.some(b=>data.notebooks.some(other=>other.subject===targetSubject&&other.name===b.name)))throw new Error('目标科目存在同名错题本，请先重命名');
   next={...data,notebooks:data.notebooks.map(b=>b.subject===subject?{...b,subject:targetSubject}:b),mistakes:data.mistakes.map(m=>m.subject===subject?{...m,subject:targetSubject}:m)};
  }else if(mode==='delete'){
   next=cleanPaper(data,data.mistakes.filter(m=>m.subject!==subject));
   next={...next,notebooks:next.notebooks.filter(b=>b.subject!==subject)};
  }else throw new Error('请选择移动内容或一起删除');
 }
 return {...next,subjects:next.subjects.filter(s=>s!==subject)};
}
export function renameTag(data, previous, value) {
 const name=requiredName(value,30);if(!data.tags.includes(previous))throw new Error('标签不存在');
 if(name!==previous&&data.tags.includes(name))throw new Error('已有同名标签');
 return {...data,tags:data.tags.map(tag=>tag===previous?name:tag),mistakes:data.mistakes.map(m=>({...m,tags:(m.tags||[]).map(tag=>tag===previous?name:tag)}))};
}
export function removeTag(data, tag) {
 return {...data,tags:data.tags.filter(value=>value!==tag),mistakes:data.mistakes.map(m=>({...m,tags:(m.tags||[]).filter(value=>value!==tag)}))};
}
export function updateMistake(data, mistakeId, patch, reviewed=false) {
 const original=data.mistakes.find(m=>m.id===mistakeId);if(!original)throw new Error('题目不存在');
 if(!patch.question?.trim())throw new Error('请填写题干');
 if(!QUESTION_TYPES.includes(patch.type))throw new Error('请选择有效题型');
 const fields={};for(const key of ['number','question','studentAnswer','correctAnswer','explanation','source'])fields[key]=String(patch[key]??original[key]??'').trim();
 fields.type=patch.type;fields.figures=questionFigures(patch);fields.parts=normalizeParts(patch.parts??original.parts);
 fields.editedAt=Date.now();fields.reviewedSignature=reviewed?questionSignature(fields):'';
 const updated={...original,...fields,title:fields.question.slice(0,65)};
 return {...data,mistakes:data.mistakes.map(m=>m.id===mistakeId?updated:m),sessions:(data.sessions||[]).map(session=>session.id===original.sourceSessionId?{
  ...session,questions:session.questions.map((q,index)=>index===original.questionIndex?{...q,recognizedQuestion:q.recognizedQuestion??q.question,...fields,confidence:'人工核对'}:q)
 }:session)};
}
