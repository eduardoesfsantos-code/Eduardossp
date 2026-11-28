// Dois processos, dois bancos e duas chaves independentes. Somente dados fictícios.
// Este teste NÃO demonstra isolamento multiempresa dentro de um banco compartilhado.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:net';
import {io} from 'socket.io-client';
import Database from 'better-sqlite3';
const root=mkdtempSync(path.join(tmpdir(),'obraponto-isolamento-'));
const cwd=path.dirname(fileURLToPath(import.meta.url)),instances=[],sockets=[];
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const email='admin@example.test',workerEmail='worker@example.test';
const start=async label=>{
 const probe=createServer();
 await new Promise((resolve,reject)=>{probe.once('error',reject);probe.listen(0,'127.0.0.1',resolve);});
 const port=probe.address().port;await new Promise(r=>probe.close(r));
 const dbPath=path.join(root,label,'db.sqlite'),secret=randomBytes(48).toString('hex'),password='Teste-isolado-'+label+'-123456';
 const server=spawn(process.execPath,['server.js'],{cwd,env:{...process.env,PORT:String(port),DB_PATH:dbPath,JWT_SECRET:secret,ADMIN_EMAIL:email,ADMIN_NAME:'Admin '+label,ADMIN_PASSWORD:password,NODE_ENV:'test',RESEND_API_KEY:'',OBRAPONTO_EMAIL_FROM:'',OBRAPONTO_PRIVATE_DOCUMENTS:'1',OBRAPONTO_REQUIRE_EMAIL_VERIFICATION:'1'},stdio:['ignore','pipe','pipe']});
 const instance={label,server,dbPath,password,base:'http://127.0.0.1:'+port,logs:''};instances.push(instance);
 server.stdout.on('data',d=>instance.logs+=d);server.stderr.on('data',d=>instance.logs+=d);
 for(let i=0;i<120;i++){try{if((await fetch(instance.base+'/api/health')).ok)return instance;}catch{}if(server.exitCode!==null)break;await wait(150);}
 throw Error('Instância de teste não iniciou: '+label+' '+instance.logs);
};
const call=async(i,url,token,method='GET',body,expected=200)=>{
 const res=await fetch(i.base+'/api'+url,{method,headers:{...(token?{Authorization:'Bearer '+token}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
 assert.equal(res.status,expected,i.label+' '+method+' '+url+' '+(res.status===expected?'':await res.clone().text()));
 return res.headers.get('content-type')?.includes('application/json')?res.json():Buffer.from(await res.arrayBuffer());
};
const connect=(i,token,shouldConnect)=>new Promise((resolve,reject)=>{
 const s=io(i.base,{auth:{token},transports:['websocket'],reconnection:false,timeout:3000,autoConnect:false});sockets.push(s);
 const timeout=setTimeout(()=>reject(Error('Socket sem resposta: '+i.label)),5000);
 s.once('connect',()=>{clearTimeout(timeout);if(!shouldConnect){s.disconnect();reject(Error('Socket aceitou token de outra empresa'));}else resolve(s);});
 s.once('connect_error',e=>{clearTimeout(timeout);if(shouldConnect)reject(e);else {s.disconnect();resolve(null);}});s.connect();
});
try{
 const a=await start('empresa-a'),b=await start('empresa-b');
 const configure=async i=>{
  i.admin=(await call(i,'/login',null,'POST',{email,password:i.password})).token;
  i.workerId=(await call(i,'/admin/workers',i.admin,'POST',{name:'Colaborador '+i.label,email:workerEmail,password:i.password},201)).worker.id;
  // Confirmação simulada somente neste banco temporário de teste.
  const db=new Database(i.dbPath);try{db.prepare('UPDATE users SET email_verified_at=? WHERE id=?').run(new Date().toISOString(),i.workerId);}finally{db.close();}
  i.worker=(await call(i,'/login',null,'POST',{email:workerEmail,password:i.password})).token;
  i.site=(await call(i,'/admin/sites',i.admin,'POST',{name:'Obra '+i.label,city:'Cotia'},201)).id;
  await call(i,'/admin/company',i.admin,'PATCH',{trade_name:'Empresa '+i.label});
  i.day=(await call(i,'/me',i.worker)).today;
  await call(i,'/admin/assignments',i.admin,'PUT',{worker_id:i.workerId,site_id:i.site,day:i.day});
  i.notice=(await call(i,'/admin/workers/'+i.workerId+'/notices',i.admin,'POST',{message:'Aviso exclusivo '+i.label},201)).id;
  i.order=(await call(i,'/admin/work-orders',i.admin,'POST',{worker_id:i.workerId,site_id:i.site,title:'OS '+i.label,description:'Ordem de teste'},201)).order.id;
  const bytes=Buffer.from('%PDF-1.4\n% documento fictício '+i.label+'\n%%EOF\n');
  i.doc=(await call(i,'/admin/workers/'+i.workerId+'/documents',i.admin,'POST',{period:i.day.slice(0,7),closed:true,data_url:'data:application/pdf;base64,'+bytes.toString('base64')},201)).id;
  const db2=new Database(i.dbPath);try{const t=i.day+'T12:00:00.000Z';db2.prepare('INSERT INTO punches (id,user_id,site_id,day,type,at,created_at) VALUES (?,?,?,?,?,?,?)').run('punch-'+i.label,i.workerId,i.site,i.day,'in',t,t);}finally{db2.close();}
 };
 await configure(a);await configure(b);
 const verify=async(own,foreign)=>{
  for(const [mail,token] of [[email,foreign.admin],[workerEmail,foreign.worker]]){
   await call(own,'/login',null,'POST',{email:mail,password:foreign.password},401);
   await call(own,'/me',token,'GET',undefined,401);
   await call(own,'/notifications',token,'GET',undefined,401);
   await connect(own,token,false);
  }
  const workers=(await call(own,'/admin/workers',own.admin)).workers;
  assert.deepEqual(workers.map(w=>w.id),[own.workerId]);
  assert.deepEqual((await call(own,'/sites',own.worker)).sites.map(s=>s.id),[own.site]);
  assert.equal((await call(own,'/company/branding',own.worker)).trade_name,'Empresa '+own.label);
  assert.deepEqual((await call(own,'/admin/work-orders',own.admin)).orders.map(o=>o.id),[own.order]);
  assert.deepEqual((await call(own,'/worker/documents',own.worker)).documents.map(d=>d.id),[own.doc]);
  await call(own,'/documents/'+foreign.doc+'/download',own.admin,'GET',undefined,404);
  await call(own,'/documents/'+foreign.doc+'/download',own.worker,'GET',undefined,404);
  await call(own,'/admin/workers/'+foreign.workerId,own.admin,'PATCH',{name:'Tentativa cruzada'},404);
  await call(own,'/admin/sites/'+foreign.site,own.admin,'DELETE',undefined,404);
  await call(own,'/worker/work-orders/'+foreign.order+'/status',own.worker,'PATCH',{status:'accepted'},404);
  await call(own,'/worker/notices/'+foreign.notice+'/read',own.worker,'PATCH',{},404);
  await call(own,'/notifications/read',own.worker,'PATCH',{ids:['document:'+foreign.doc]},404);
  const dash=await call(own,'/admin/dashboard',own.admin);
  assert.ok(dash.activity.some(p=>p.id==='punch-'+own.label));
  assert.ok(!dash.activity.some(p=>p.id==='punch-'+foreign.label));
  assert.ok(!(await call(own,'/notifications',own.worker)).notifications.some(n=>n.id==='document:'+foreign.doc));
 };
 await verify(a,b);await verify(b,a);
 const socketA=await connect(a,a.worker,true),socketB=await connect(b,b.worker,true);
 let eventsA=0,eventsB=0;socketA.on('changed',()=>eventsA++);socketB.on('changed',()=>eventsB++);
 await call(a,'/admin/workers/'+a.workerId+'/notices',a.admin,'POST',{message:'Evento exclusivo da empresa A'},201);
 for(let n=0;n<30&&!eventsA;n++)await wait(100);
 assert.ok(eventsA>0);await wait(300);assert.equal(eventsB,0);
 console.log('ISOLAMENTO_INSTANCIAS_OK: credenciais, JWT, WebSocket, funcionários, obras, pontos, OS, avisos e documentos.');
}finally{
 for(const s of sockets)s.disconnect();
 for(const i of instances){if(i.server.exitCode===null){const exit=new Promise(r=>i.server.once('exit',r));i.server.kill('SIGTERM');await exit;}}
 rmSync(root,{recursive:true,force:true});
}
