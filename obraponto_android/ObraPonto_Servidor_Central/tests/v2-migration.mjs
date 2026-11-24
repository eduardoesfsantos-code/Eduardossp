import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {existsSync,mkdtempSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const dir=mkdtempSync(path.join(tmpdir(),'obraponto-legacy-'));
const dbPath=path.join(dir,'obraponto.sqlite');
const db=new Database(dbPath);
db.exec(`
CREATE TABLE users (
 id TEXT PRIMARY KEY,name TEXT NOT NULL,email TEXT NOT NULL UNIQUE COLLATE NOCASE,
 phone TEXT DEFAULT '',employee_code TEXT DEFAULT '',trade TEXT DEFAULT '',
 role TEXT NOT NULL CHECK(role IN ('admin','worker')),
 password_hash TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL
);
`);
const password='senha_super_segura_1234';
const createdAt=new Date().toISOString();
db.prepare('INSERT INTO users (id,name,email,role,password_hash,created_at) VALUES(?,?,?,?,?,?)').run(
 'admin-legacy','Administrador Antigo','teste-admin@example.com','admin',bcrypt.hashSync(password,10),createdAt);
db.prepare('INSERT INTO users (id,name,email,role,password_hash,created_at) VALUES(?,?,?,?,?,?)').run(
 'worker-legacy','Funcionário Histórico','worker@example.com','worker',bcrypt.hashSync('worker-1234',10),createdAt);
db.close();

const port=19000+Math.floor(Math.random()*2500);
const base='http://127.0.0.1:'+port;
const child=spawn(process.execPath,['server.js'],{
 cwd:root,env:{...process.env,PORT:String(port),DB_PATH:dbPath,
 JWT_SECRET:'migration_test_secret_0123456789abcdefghijklmnopqrstuvwxyz',
 ADMIN_EMAIL:'outro-admin@example.com',ADMIN_PASSWORD:'outra_senha_1234567',NODE_ENV:'test'},
 stdio:['ignore','pipe','pipe']
});
let log='';
child.stdout.on('data',x=>log+=x);child.stderr.on('data',x=>log+=x);
try {
 let ready=false;
 for(let i=0;i<90;i++){
  if(child.exitCode!==null)throw Error('Falha no boot: '+log);
  try{let x=await fetch(base+'/api/health');if(x.ok){ready=true;break;}}catch{}
  await new Promise(r=>setTimeout(r,200));
 }
 assert.ok(ready,'Servidor não ficou pronto: '+log);
 const res=await fetch(base+'/api/login',{
  method:'POST',headers:{'Content-Type':'application/json'},
  body:JSON.stringify({email:'teste-admin@example.com',password})
 });
 assert.equal(res.status,200,'Autenticação do administrador antigo preservada');
 const {token}=await res.json();
 let r=await fetch(base+'/api/admin/workers',{headers:{Authorization:'Bearer '+token}});
 assert.equal(r.status,200);const {workers}=await r.json();
 assert.equal(workers.length,1);
 assert.equal(workers[0].id,'worker-legacy');
 assert.equal(workers[0].archived_at,null);
 r=await fetch(base+'/api/admin/company',{headers:{Authorization:'Bearer '+token}});
 assert.equal(r.status,200,'Novo painel Empresa acessível após migração');
 const bk=path.join(dir,'backups');
 assert.ok(existsSync(bk),'Backup pré-migração não foi criado');
 const names=readdirSync(bk).filter(n=>n.endsWith('.sqlite'));
 assert.equal(names.length,1,'Backup único pré-migração');
 const backup=new Database(path.join(bk,names[0]),{readonly:true});
 try{
  assert.equal(backup.prepare('SELECT COUNT(*) AS n FROM users').get().n,2);
  assert.equal(backup.pragma('table_info(users)').some(x=>x.name==='archived_at'),false);
 }finally{backup.close();}
 console.log('Migração preservou dados antigos; backup consistente e histórico disponíveis.');
}finally{
 child.kill('SIGTERM');
 rmSync(dir,{force:true,recursive:true,maxRetries:3,retryDelay:100});
}
