import { WorkspaceStore } from '../workspace-store.mjs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
const [action,username]=process.argv.slice(2);
if(!['create','reset-password','disable','list'].includes(action))throw new Error('用法：node scripts/accounts.mjs create|reset-password|disable|list [用户名]；密码通过标准输入传入');
const store=new WorkspaceStore(resolve(process.env.DATA_DIR||'.local'));
try{
 if(action==='list')console.log(store.db.prepare('SELECT id,username,disabled FROM users').all());
 else if(action==='disable')store.disable(username);
 else{let password='';if(process.stdin.isTTY){process.stderr.write('密码（输入不回显）：');const muted=new Writable({write(chunk,encoding,done){done()}});const input=createInterface({input:process.stdin,output:muted,terminal:true});try{password=await input.question('')}finally{input.close();process.stderr.write('\n')}}else{for await(const chunk of process.stdin){password+=chunk;if(password.length>1024)throw new Error('密码输入过长')}}password=password.replace(/\r?\n$/,'');console.log(action==='create'?await store.createUser(username,password):await store.resetPassword(username,password)||'密码已重置，旧会话已注销')}
}finally{store.close()}
