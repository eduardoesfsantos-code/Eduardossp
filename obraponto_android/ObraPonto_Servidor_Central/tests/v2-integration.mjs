import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const tmp=mkdtempSync(path.join(tmpdir(),'obraponto-v2-'));
const port=18765+Math.floor(Math.random()*900);
const base=`http://127.0.0.1:${port}`;
const child=spawn(process.execPath,['server.js'],{cwd:root,env:{...process.env,PORT:String(port),DB_PATH:path.join(tmp,'test.sqlite'),JWT_SECRET:'unit_test_secret_0123456789abcdefghijklmnopqrstuvwxyz',ADMIN_NAME:'Administrador QA',ADMIN_EMAIL:'teste-admin@example.com',ADMIN_PASSWORD:'senha_super_segura_1234',NODE_ENV:'test'},stdio:['ignore','pipe','pipe']});
let logs='';child.stdout.on('data',d=>{logs+=d.toString()});child.stderr.on('data',d=>{logs+=d.toString()});
const json=async(url,{method='GET',token,body}={})=>{
 const r=await fetch(base+url,{method,headers:{...(token?{Authorization:`Bearer ${token}`}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
 return {status:r.status,body:await r.json().catch(()=>({}))};
};
try{
 let ready=false;
 for(let i=0;i<90;i++){
  if(child.exitCode!==null)throw Error('Servidor encerrou: '+logs);
  try{const r=await fetch(base+'/api/health');if(r.ok){ready=true;break;}}catch{}
  await new Promise(resolve=>setTimeout(resolve,200));
 }
 assert.ok(ready,'servidor não iniciou: '+logs);
 const login=await json('/api/login',{method:'POST',body:{email:'teste-admin@example.com',password:'senha_super_segura_1234'}});
 assert.equal(login.status,200,JSON.stringify(login.body)); const token=login.body.token;
 const c0=await json('/api/admin/company',{token});assert.equal(c0.status,200);
 const logo='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBTcAAAAASUVORK5CYII=';
 const c1=await json('/api/admin/company',{method:'PATCH',token,body:{trade_name:'Empresa Teste QA',legal_name:'Empresa Teste Ltda',cnpj:'12.345.678/0001-95',phone:'11999999999',logo_data_url:logo,allow_worker_select_site:false,allow_worker_requests:false,workday_minutes:480}});
 assert.equal(c1.status,200,JSON.stringify(c1.body));assert.equal(c1.body.company.trade_name,'Empresa Teste QA');
 const created=await json('/api/admin/workers',{method:'POST',token,body:{name:'Carlos Teste',email:'carlos@example.com',password:'funcionario123'}});
 assert.equal(created.status,201,JSON.stringify(created.body));const workerId=created.body.worker.id;
 const archive=await json(`/api/admin/workers/${workerId}`,{method:'DELETE',token});assert.equal(archive.status,200);
 const absent=await json('/api/admin/workers',{token});assert.ok(!absent.body.workers.some(w=>w.id===workerId));
 const archived=await json('/api/admin/workers?include_archived=1',{token});assert.equal(archived.body.workers.find(w=>w.id===workerId).active,false);
 const denied=await json('/api/login',{method:'POST',body:{email:'carlos@example.com',password:'funcionario123'}});assert.equal(denied.status,401);
 const restored=await json(`/api/admin/workers/${workerId}`,{method:'PATCH',token,body:{restore:true,active:true}});assert.equal(restored.status,200,JSON.stringify(restored.body));
 const workerLogin=await json('/api/login',{method:'POST',body:{email:'carlos@example.com',password:'funcionario123'}});assert.equal(workerLogin.status,200);
 const blocked=await json('/api/worker/requests',{method:'POST',token:workerLogin.body.token,body:{day:'2026-11-23',message:'Teste'}});assert.equal(blocked.status,403);
 for(const [format,mime,header] of [['pdf','application/pdf','%PDF'],['xlsx','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','PK']]){
  const r=await fetch(base+`/api/admin/report/export?worker_id=${workerId}&from=2026-11-01&to=2026-11-30&format=${format}`,{headers:{Authorization:`Bearer ${token}`}});
  if(r.status!==200)throw Error('Falha exportacao '+format+': '+await r.text());assert.ok(r.headers.get('content-type').includes(mime));const bytes=Buffer.from(await r.arrayBuffer());assert.ok(bytes.subarray(0,4).toString('latin1').startsWith(header));
 }
 console.log('V2 integrações OK: perfil/logo, permissões, arquivamento/restauração, PDF, XLSX');
}finally{
 child.kill('SIGTERM');
 rmSync(tmp,{force:true,recursive:true,maxRetries:3,retryDelay:100});
}
