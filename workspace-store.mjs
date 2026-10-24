import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, createHash, scrypt as scryptCallback, timingSafeEqual, createCipheriv, createDecipheriv } from 'node:crypto';
import { promisify } from 'node:util';
const scrypt = promisify(scryptCallback);
const fail = (message,status=400) => Object.assign(new Error(message),{status});
const digest = value => createHash('sha256').update(value).digest('hex');
export class WorkspaceStore {
 constructor(directory) {
  mkdirSync(directory,{recursive:true,mode:0o700});
  const keyPath=join(directory,'storage.key');
  try{this.key=readFileSync(keyPath)}catch(e){if(e.code!=='ENOENT')throw e;writeFileSync(keyPath,randomBytes(32),{mode:0o600,flag:'wx'});this.key=readFileSync(keyPath)}
  chmodSync(keyPath,0o600);
  if(this.key.length!==32)throw new Error('storage.key 长度无效');
  this.db=new DatabaseSync(join(directory,'workspace.sqlite'));
  chmodSync(join(directory,'workspace.sqlite'),0o600);
  if(this.db.prepare('PRAGMA user_version').get().user_version>1)throw new Error('数据版本比当前程序更新，禁止降级写入');
  this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
   CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL, disabled INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS revisions(user_id TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE IF NOT EXISTS entries(user_id TEXT NOT NULL, store TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(user_id,store,key)); PRAGMA user_version=1;`);
 }
 encrypt(value){const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',this.key,iv);return this.seal(c,iv,value)}
 seal(c,iv,value){const data=Buffer.concat([c.update(JSON.stringify(value),'utf8'),c.final()]);return Buffer.concat([iv,c.getAuthTag(),data]).toString('base64')}
 decrypt(value){const b=Buffer.from(value,'base64'),d=createDecipheriv('aes-256-gcm',this.key,b.subarray(0,12));d.setAuthTag(b.subarray(12,28));return JSON.parse(Buffer.concat([d.update(b.subarray(28)),d.final()]).toString('utf8'))}
 async passwordHash(password){if(typeof password!=='string'||password.length<12||password.length>256)throw fail('密码需为 12–256 个字符');const salt=randomBytes(16).toString('hex');return `${salt}:${Buffer.from(await scrypt(password,salt,64)).toString('hex')}`}
 async createUser(username,password){if(typeof username!=='string'||! /^[a-zA-Z0-9_.@-]{3,80}$/.test(username))throw fail('用户名限 3–80 位字母、数字、点、横线、下划线或 @');const hash=await this.passwordHash(password);const id=randomBytes(16).toString('hex');this.db.prepare('INSERT INTO users(id,username,password) VALUES(?,?,?)').run(id,username.toLowerCase(),hash);return{id,username:username.toLowerCase()}}
 async login(username,password){if(typeof password!=='string'||password.length>256)throw fail('用户名或密码错误',401);const user=this.db.prepare('SELECT * FROM users WHERE username=?').get(String(username).toLowerCase());const [salt,expected]=(user?.password||'00000000000000000000000000000000:'+ '00'.repeat(64)).split(':');const actual=await scrypt(password,salt,64);if(!user||user.disabled||!timingSafeEqual(actual,Buffer.from(expected,'hex')))throw fail('用户名或密码错误',401);const token=randomBytes(32).toString('hex');this.db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now());this.db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(digest(token),user.id,Date.now()+7*86400000);return{token,user:{id:user.id,username:user.username}}}
 user(token){if(!token)return null;return this.db.prepare('SELECT users.id,users.username FROM sessions JOIN users ON users.id=sessions.user_id WHERE token=? AND expires>? AND disabled=0').get(digest(token),Date.now())||null}
 logout(token){if(token)this.db.prepare('DELETE FROM sessions WHERE token=?').run(digest(token))}
 async resetPassword(username,password){const hash=await this.passwordHash(password);const user=this.db.prepare('SELECT id FROM users WHERE username=?').get(username.toLowerCase());if(!user)throw fail('账号不存在',404);this.db.prepare('UPDATE users SET password=? WHERE id=?').run(hash,user.id);this.db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id)}
 disable(username){const user=this.db.prepare('SELECT id FROM users WHERE username=?').get(username.toLowerCase());if(!user)throw fail('账号不存在',404);this.db.prepare('UPDATE users SET disabled=1 WHERE id=?').run(user.id);this.db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id)}
 revision(uid){return this.db.prepare('SELECT revision FROM revisions WHERE user_id=?').get(uid)?.revision||0}
 validate(store,key){if(!['workspace','pdfFiles'].includes(store)||typeof key!=='string'||!key.length||key.length>200)throw fail('存储位置无效')}
 get(uid,store,key){this.validate(store,key);const row=this.db.prepare('SELECT value FROM entries WHERE user_id=? AND store=? AND key=?').get(uid,store,key);return row?this.decrypt(row.value):null}
 commit(uid,revision,ops){if(!Array.isArray(ops)||ops.length>1000)throw fail('事务无效');for(const op of ops){this.validate(op.store,op.key||'*');if(!['put','delete','clear'].includes(op.type))throw fail('操作无效');if(op.type==='put'&&op.value===undefined)throw fail('缺少数据')}
  this.db.exec('BEGIN IMMEDIATE');try{if(revision!==this.revision(uid))throw fail('另一页面或设备已更新数据，请刷新后重试；本次未覆盖',409);
   for(const op of ops){if(op.type==='put')this.db.prepare('INSERT OR REPLACE INTO entries VALUES(?,?,?,?)').run(uid,op.store,op.key,this.encrypt(op.value));else if(op.type==='delete')this.db.prepare('DELETE FROM entries WHERE user_id=? AND store=? AND key=?').run(uid,op.store,op.key);else this.db.prepare('DELETE FROM entries WHERE user_id=? AND store=?').run(uid,op.store)}
   this.db.prepare('INSERT INTO revisions VALUES(?,1) ON CONFLICT(user_id) DO UPDATE SET revision=revision+1').run(uid);this.db.exec('COMMIT');return this.revision(uid);
  }catch(e){this.db.exec('ROLLBACK');throw e}
 }
 close(){this.db.close()}
}
