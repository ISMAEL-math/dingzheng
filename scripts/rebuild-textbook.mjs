import { readFile, readdir, mkdir, copyFile, writeFile, rename } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { buildStructuredDocument } from '../textbook-structured.mjs';
import { extractQuestionRecords, validateQuestionRecords } from '../textbook-pipeline.mjs';

const directory = process.argv[2];
if (!directory) throw new Error('用法: node scripts/rebuild-textbook.mjs <教材目录> [--apply]（默认仅预览）');
const root = resolve(directory);
const book = JSON.parse(await readFile(join(root, 'book.json'), 'utf8'));
const oldQuestions = JSON.parse(await readFile(join(root, 'questions.json'), 'utf8'));
if (['queued', 'running'].includes(book.job?.status)) throw new Error('教材仍在处理中，请完成后重建');
const files = join(root, 'mineru', 'files');
const name = (await readdir(files, { recursive: true })).sort().find(n => n.endsWith('_content_list.json') || n === 'content_list.json');
if (!name) throw new Error('缺少 content_list.json，无法离线重建');
const document = buildStructuredDocument(JSON.parse(await readFile(join(files, name), 'utf8')), book.pageCount || 0);
const questions = validateQuestionRecords(extractQuestionRecords(document, book.bookId));
const unscopedAnswerPages = [...new Set(document.pages.flatMap(p => p.blocks).filter(b => b.region === 'answer' && !b.group).map(b => b.pageNumber))];
const report = { previousCandidates: oldQuestions.length, candidates: questions.length, paired: questions.filter(q=>q.correctAnswer).length, withoutIssues: questions.filter(q=>!q.issues.length).length, unscopedAnswerPages, groups: [...new Set(questions.map(q=>q.exerciseGroup))] };
console.log(JSON.stringify(report,null,2));
if (process.argv.includes('--apply')) {
 if (book.published || oldQuestions.some(q => ['verified','rejected'].includes(q.status) || q.verificationHistory?.length)) throw new Error('存在已发布或人工处理记录，请合并人工结果后重建；本次未写入');
 const backup = join(root,'backups',`before-structured-${Date.now()}`);
 await mkdir(backup,{recursive:true});
 for (const file of ['book.json','questions.json','document-pages.json']) {
  try { await copyFile(join(root,file),join(backup,file)); } catch(e) { if(e.code!=='ENOENT') throw e; }
 }
 const atomic = async (name,value) => { const dest=join(root,name);await writeFile(dest+'.rebuild.tmp',JSON.stringify(value,null,2)+'\n',{mode:0o600});await rename(dest+'.rebuild.tmp',dest); };
 book.sections=document.headings;book.pageCount=document.pageCount;book.pageNumbersKnown=true;
 book.questionCount=questions.length;book.verifiedCount=0;book.pendingReviewCount=questions.length;book.rejectedCount=0;
 book.warnings=(book.warnings||[]).filter(w=>!w.includes('页码')&&!w.includes('未识别到可靠'));
 if(unscopedAnswerPages.length) book.warnings.push(`PDF 第 ${unscopedAnswerPages.join('、')} 页答案区缺少可靠练习组，尚未关联，请核对原图及 OCR。`);
 book.processingStatus='completed';book.processingError='';book.cleaningStatus='skipped';book.cleaningNote='已使用保存的结构化解析结果离线重建；全部候选仍需核验。';
 book.job={...book.job,status:'completed',stage:'quality',failedStage:'',error:'',completedStages:['upload','mineru','structure','extract','clean','quality'],progress:{completed:questions.length,total:questions.length},updatedAt:Date.now(),message:'结构化重建完成，等待核验'};
 book.structureVersion=2;
 await atomic('document-pages.json',document.pages);await atomic('questions.json',questions);await atomic('book.json',book);
 await atomic('rebuild-report.json',{...report,backup});console.log(`已备份并重建：${backup}`);
}
