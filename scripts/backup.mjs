import { cp, mkdir, readdir, lstat, readFile, writeFile, rm, access } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join, relative, isAbsolute } from 'node:path';
const [action,sourceArg,targetArg]=process.argv.slice(2);
if(!['create','verify','restore'].includes(action)||!sourceArg||(action!=='verify'&&!targetArg))throw new Error('用法：node scripts/backup.mjs create <已停止服务的数据目录> <新备份目录> | verify <备份目录> | restore <备份目录> <全新数据目录>');
const source=resolve(sourceArg),target=targetArg?resolve(targetArg):null;
async function files(root,path=''){const result=[];for(const entry of await readdir(join(root,path),{withFileTypes:true})){const name=path?`${path}/${entry.name}`:entry.name;const stat=await lstat(join(root,name));if(stat.isSymbolicLink())throw new Error(`拒绝符号链接：${name}`);if(stat.isDirectory())result.push(...await files(root,name));else if(stat.isFile())result.push(name);else throw new Error(`不支持的文件：${name}`)}return result.sort()}
async function hash(path){const h=createHash('sha256');for await(const chunk of createReadStream(path))h.update(chunk);return h.digest('hex')}
async function stopped(root){try{const lock=JSON.parse(await readFile(join(root,'server.lock'),'utf8'));try{process.kill(lock.pid,0);throw new Error('请先停止应用再备份，确保数据库与教材文件是同一时刻的数据')}catch(e){if(e.code!=='ESRCH')throw e}}catch(e){if(e.code!=='ENOENT')throw e}}
async function unused(path){try{await access(path);throw new Error('目标目录已存在；为避免覆盖，请选择新目录')}catch(e){if(e.code!=='ENOENT')throw e}}
async function verify(){const manifest=JSON.parse(await readFile(join(source,'manifest.json'),'utf8'));if(manifest.format!=='dingzheng-full-backup'||manifest.version!==1||!Array.isArray(manifest.files))throw new Error('备份清单无效');const found=await files(join(source,'data'));const expected=manifest.files.map(x=>x.path).sort();if(JSON.stringify(found)!==JSON.stringify(expected))throw new Error('备份文件清单不一致');for(const item of manifest.files){const resolved=resolve(source,'data',item.path),rel=relative(join(source,'data'),resolved);if(!rel||rel.startsWith('..')||isAbsolute(rel))throw new Error('路径无效');if(await hash(resolved)!==item.sha256)throw new Error(`校验失败：${item.path}`)}return manifest}
if(target){const rel=relative(source,target);if(!rel||(!rel.startsWith('..')&&!isAbsolute(rel)))throw new Error('目标不能在源目录内');await unused(target)}
if(action==='create'){
 await stopped(source);await mkdir(target,{recursive:true,mode:0o700});
 try{await files(source);await cp(source,join(target,'data'),{recursive:true,filter:path=>!path.endsWith('/server.lock')});const entries=[];for(const path of await files(join(target,'data')))entries.push({path,sha256:await hash(join(target,'data',path))});await writeFile(join(target,'manifest.json'),JSON.stringify({format:'dingzheng-full-backup',version:1,createdAt:new Date().toISOString(),files:entries},null,2),{mode:0o600});console.log(`备份完成：${entries.length} 个文件；包含账号、加密密钥、原件及解析结果，请私密保存。`)}catch(e){await rm(target,{recursive:true,force:true});throw e}
}else{const manifest=await verify();if(action==='restore'){await mkdir(target,{recursive:true,mode:0o700});await cp(join(source,'data'),target,{recursive:true});console.log('已恢复到新目录；原数据未覆盖。使用 DATA_DIR 指向新目录后启动。')}else console.log(`校验通过：${manifest.files.length} 个文件`)}
