import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { randomUUID, randomInt, createHmac, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';
import ExcelJS from 'exceljs';

const here = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.resolve(here, process.env.DB_PATH || './data/obraponto.sqlite');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 10000');
// Backup de transição criado antes de qualquer migração da V2.
// A cópia fica no volume persistente; NÃO substitui backup externo.
const legacySchema=db.pragma('table_info(users)').length>0 && db.pragma('table_info(company_profile)').length===0;
if(legacySchema){
 const backupDir=path.join(path.dirname(dbPath),'backups');
 fs.mkdirSync(backupDir,{recursive:true,mode:0o700});
 const backupFile=path.join(backupDir,`obraponto-antes-v2-${new Date().toISOString().replace(/[:.]/g,'-')}.sqlite`);
 db.prepare('VACUUM INTO ?').run(backupFile);
 console.log('Cópia de segurança pré-V2 criada no volume persistente.');
}
db.exec(`
CREATE TABLE IF NOT EXISTS users (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
 phone TEXT DEFAULT '', employee_code TEXT DEFAULT '', trade TEXT DEFAULT '',
 role TEXT NOT NULL CHECK(role IN ('admin','worker')),
 password_hash TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sites (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, city TEXT NOT NULL,
 address TEXT DEFAULT '', active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS assignments (
 worker_id TEXT NOT NULL REFERENCES users(id), day TEXT NOT NULL,
 site_id TEXT NOT NULL REFERENCES sites(id), assigned_by TEXT REFERENCES users(id),
 updated_at TEXT NOT NULL, PRIMARY KEY(worker_id,day)
);
CREATE TABLE IF NOT EXISTS punches (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
 site_id TEXT NOT NULL REFERENCES sites(id), day TEXT NOT NULL,
 type TEXT NOT NULL CHECK(type IN ('in','break_start','break_end','out')),
 at TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_punch_user_day ON punches(user_id,day,at);
CREATE TABLE IF NOT EXISTS requests (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
 day TEXT NOT NULL, message TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
 admin_note TEXT DEFAULT '', created_at TEXT NOT NULL, decided_at TEXT
);
CREATE TABLE IF NOT EXISTS email_verification (
 user_id TEXT PRIMARY KEY REFERENCES users(id),
 email TEXT NOT NULL, nonce TEXT NOT NULL, digest TEXT NOT NULL,
 expires_at INTEGER NOT NULL, sent_at INTEGER NOT NULL,
 window_start INTEGER NOT NULL, send_count INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS privacy_requests (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
 kind TEXT NOT NULL CHECK(kind IN ('access','correction','deletion')),
 message TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','in_review','answered')),
 response TEXT, decided_by TEXT REFERENCES users(id), created_at TEXT NOT NULL, answered_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_privacy_requests_user ON privacy_requests(user_id,created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_privacy_request_open ON privacy_requests(user_id,kind) WHERE status IN ('pending','in_review');
CREATE TABLE IF NOT EXISTS punch_rectifications (
 id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE REFERENCES requests(id),
 user_id TEXT NOT NULL REFERENCES users(id), day TEXT NOT NULL,
 action TEXT NOT NULL CHECK(action IN ('add','adjust','void')),
 target_id TEXT, type TEXT NOT NULL CHECK(type IN ('in','break_start','break_end','out')),
 site_id TEXT NOT NULL REFERENCES sites(id), previous_at TEXT, corrected_at TEXT,
 reason TEXT NOT NULL, actor_id TEXT NOT NULL REFERENCES users(id),
 actor_name TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rectifications_user_day ON punch_rectifications(user_id,day);
CREATE TRIGGER IF NOT EXISTS rectifications_no_update BEFORE UPDATE ON punch_rectifications
 BEGIN SELECT RAISE(ABORT,'Retificações não podem ser modificadas'); END;
CREATE TRIGGER IF NOT EXISTS rectifications_no_delete BEFORE DELETE ON punch_rectifications
 BEGIN SELECT RAISE(ABORT,'Retificações não podem ser excluídas'); END;
CREATE TABLE IF NOT EXISTS audit (
 id TEXT PRIMARY KEY, actor_id TEXT REFERENCES users(id), action TEXT NOT NULL,
 object_id TEXT DEFAULT '', detail TEXT DEFAULT '', at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS company_profile (
 id INTEGER PRIMARY KEY CHECK(id=1),
 legal_name TEXT NOT NULL DEFAULT '',
 trade_name TEXT NOT NULL DEFAULT '',
 cnpj TEXT NOT NULL DEFAULT '',
 contact_email TEXT NOT NULL DEFAULT '',
 phone TEXT NOT NULL DEFAULT '',
 address TEXT NOT NULL DEFAULT '',
 logo_data_url TEXT NOT NULL DEFAULT '',
 allow_worker_select_site INTEGER NOT NULL DEFAULT 1,
 allow_worker_requests INTEGER NOT NULL DEFAULT 1,
 workday_minutes INTEGER NOT NULL DEFAULT 480,
 updated_at TEXT NOT NULL
);
INSERT OR IGNORE INTO company_profile (id,trade_name,updated_at) VALUES (1,'Minha empresa',CURRENT_TIMESTAMP);
`);

// Migração aditiva: não apaga dados nem registros de jornada existentes.
if(!db.pragma('table_info(users)').some(c=>c.name==='archived_at')) {
 db.exec('ALTER TABLE users ADD COLUMN archived_at TEXT');
}
if(!db.pragma('table_info(users)').some(c=>c.name==='email_verified_at'))db.exec('ALTER TABLE users ADD COLUMN email_verified_at TEXT');
if(!db.pragma('table_info(users)').some(c=>c.name==='photo_data_url'))db.exec("ALTER TABLE users ADD COLUMN photo_data_url TEXT NOT NULL DEFAULT ''");
if(!db.pragma('table_info(users)').some(c=>c.name==='shift'))db.exec("ALTER TABLE users ADD COLUMN shift TEXT NOT NULL DEFAULT 'unspecified'");
db.exec(`CREATE TABLE IF NOT EXISTS worker_notices (
 id TEXT PRIMARY KEY, worker_id TEXT NOT NULL REFERENCES users(id),
 sender_id TEXT NOT NULL REFERENCES users(id), message TEXT NOT NULL,
 created_at TEXT NOT NULL, read_at TEXT
);
CREATE INDEX IF NOT EXISTS worker_notices_recipient ON worker_notices(worker_id,created_at);`);
// Documentos em fase de teste, desabilitados por padrão. Não servir em rotas públicas.
db.exec(`CREATE TABLE IF NOT EXISTS private_documents (
 id TEXT PRIMARY KEY, worker_id TEXT NOT NULL REFERENCES users(id),
 uploader_id TEXT NOT NULL REFERENCES users(id), kind TEXT NOT NULL CHECK(kind IN ('medical','payslip','timesheet')),
 period TEXT NOT NULL DEFAULT '', mime TEXT NOT NULL, content BLOB NOT NULL,
 created_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'received', reviewed_at TEXT
);
CREATE INDEX IF NOT EXISTS private_documents_owner ON private_documents(worker_id,created_at);`);
// Preserva documentos legados sem convertê-los em folhas de ponto.
if(!db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='private_documents'").get().sql.includes("'timesheet'")){
 db.transaction(()=>{
  db.exec(`CREATE TABLE private_documents_next (
   id TEXT PRIMARY KEY, worker_id TEXT NOT NULL REFERENCES users(id),
   uploader_id TEXT NOT NULL REFERENCES users(id), kind TEXT NOT NULL CHECK(kind IN ('medical','payslip','timesheet')),
   period TEXT NOT NULL DEFAULT '', mime TEXT NOT NULL, content BLOB NOT NULL,
   created_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'received', reviewed_at TEXT
  );
  INSERT INTO private_documents_next (id,worker_id,uploader_id,kind,period,mime,content,created_at,status,reviewed_at)
  SELECT id,worker_id,uploader_id,kind,period,mime,content,created_at,status,reviewed_at FROM private_documents;
  DROP TABLE private_documents;
  ALTER TABLE private_documents_next RENAME TO private_documents;
  CREATE INDEX private_documents_owner ON private_documents(worker_id,created_at);`);
 })();
}
db.exec(`CREATE TABLE IF NOT EXISTS work_orders (
 number INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
 worker_id TEXT NOT NULL REFERENCES users(id), site_id TEXT NOT NULL REFERENCES sites(id),
 creator_id TEXT NOT NULL REFERENCES users(id), title TEXT NOT NULL, description TEXT NOT NULL,
 priority TEXT NOT NULL CHECK(priority IN ('normal','high','urgent')),
 due_day TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'sent' CHECK(status IN ('sent','accepted','in_progress','completed','cancelled')),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 accepted_at TEXT, started_at TEXT, completed_at TEXT, cancelled_at TEXT, completion_note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS work_orders_worker ON work_orders(worker_id,number DESC);`);
const documentsEnabled=process.env.OBRAPONTO_PRIVATE_DOCUMENTS==='1';
const companyProfile=()=>{
 const row=db.prepare('SELECT * FROM company_profile WHERE id=1').get();
 return {...row,allow_worker_select_site:!!row.allow_worker_select_site,allow_worker_requests:!!row.allow_worker_requests};
};
const now = () => new Date().toISOString();
const dateBR = (d = new Date()) => new Intl.DateTimeFormat('en-CA', {timeZone:'America/Sao_Paulo', year:'numeric', month:'2-digit', day:'2-digit'}).format(d);
const today = () => dateBR();
const id = () => randomUUID();
const fail = (status, message) => { const e = new Error(message); e.status = status; throw e; };
const str = (value, max = 180) => typeof value === 'string' ? value.trim().slice(0,max) : '';
const required = (value, label, max=180) => str(value,max) || fail(400, `${label} é obrigatório.`);
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(new Date(`${s}T12:00:00Z`).getTime());
const dayParam = (v, fallback=today()) => {const s = str(v,10)||fallback; if(!isDate(s)) fail(400,'Data inválida.'); return s;};
const workerShift=value=>{
 if(!['unspecified','day','night','mixed'].includes(value))fail(400,'Turno inválido.');
 return value;
};
const workerPhoto=value=>{
 if(value==='')return '';
 if(typeof value!=='string'||!/^data:image\/(jpeg|png);base64,[A-Za-z0-9+/]+={0,2}$/.test(value))fail(400,'Selecione uma foto JPG ou PNG.');
 const [head,b64]=value.split(','),buf=Buffer.from(b64,'base64');
 const png=buf.length>=24&&buf.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))&&buf.subarray(12,16).toString()==='IHDR';
 const jpg=buf.length>4&&buf[0]===255&&buf[1]===216&&buf[2]===255&&buf[buf.length-2]===255&&buf[buf.length-1]===217;
 if(buf.length>100000||!(head.includes('png')?png:jpg))fail(400,'Foto inválida ou acima de 100 KB.');
 return value;
};
const safeUser = u => u && ({id:u.id,name:u.name,email:u.email,phone:u.phone,employee_code:u.employee_code,trade:u.trade,role:u.role,active:!!u.active,created_at:u.created_at,archived_at:u.archived_at||null,email_verified:!!u.email_verified_at,photo_data_url:u.photo_data_url||'',shift:u.shift||'unspecified'});
const audit = (actorId, action, objectId='', detail='') => db.prepare('INSERT INTO audit VALUES (?,?,?,?,?,?)').run(id(),actorId,action,objectId,String(detail).slice(0,500),now());
const secret = process.env.JWT_SECRET;
if (!secret || secret.length < 32 || secret.includes('SUBSTITUA')) {
 console.error('\nERRO: configure um JWT_SECRET privado com pelo menos 32 caracteres no arquivo .env.\n');
 process.exit(1);
}
const countAdmin = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin'").get().n;
if (!countAdmin) {
 const email = str(process.env.ADMIN_EMAIL,180).toLowerCase();
 const password = process.env.ADMIN_PASSWORD || '';
 if (!email || password.length < 12) {
  console.error('\nERRO: primeiro acesso exige ADMIN_EMAIL e ADMIN_PASSWORD (mínimo 12 caracteres) no .env.\n');
  process.exit(1);
 }
 const uid = id();
 db.prepare('INSERT INTO users (id,name,email,role,password_hash,created_at) VALUES (?,?,?,?,?,?)').run(uid, str(process.env.ADMIN_NAME)||'Administrador', email, 'admin', bcrypt.hashSync(password,12), now());
 console.log(`Administrador inicial configurado: ${email}`);
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy',1); // Railway encaminha IP de origem por proxy.
app.use(helmet({contentSecurityPolicy: false}));
app.use('/api',(_req,res,next)=>{res.set('Cache-Control','private, no-store, max-age=0');res.set('Pragma','no-cache');next();});
const smallJson=express.json({limit:'256kb'}),documentJson=express.json({limit:'3mb'});
app.use((req,res,next)=>{
 const documentUpload=req.method==='POST'&&(/^\/api\/worker\/documents\/?$/.test(req.path)||/^\/api\/admin\/workers\/[^/]+\/documents\/?$/.test(req.path));
 return documentUpload?next():smallJson(req,res,next);
});
const http = createServer(app);
const io = new Server(http, {cors:{origin:false}});

function auth(req,res,next) {
 try {
  const token = (req.get('authorization')||'').replace(/^Bearer\s+/i,'');
  const payload = jwt.verify(token,secret,{algorithms:['HS256']});
  const user = db.prepare('SELECT * FROM users WHERE id=? AND active=1').get(payload.sub);
  if(!user) return res.status(401).json({error:'Sessão inválida ou usuário inativo.'});
  req.user=user; next();
 } catch {res.status(401).json({error:'Entre na sua conta novamente.'});}
}
const admin = (req,res,next) => req.user.role==='admin' ? next() : res.status(403).json({error:'Acesso restrito à administração.'});
const wrap = fn => (req,res,next) => {try {const result=fn(req,res); if(result?.catch)result.catch(next);}catch(e){next(e);}};
const changed = (resource, workerId=null) => {
 io.to('admins').emit('changed',{resource});
 if(workerId) io.to(`worker:${workerId}`).emit('changed',{resource});
 if(resource==='sites'||resource==='company') io.to('workers').emit('changed',{resource});
};
io.use((socket,next)=>{
 try {const p=jwt.verify(socket.handshake.auth?.token||'',secret,{algorithms:['HS256']}); const u=db.prepare('SELECT * FROM users WHERE id=? AND active=1').get(p.sub); if(!u)throw Error('unauthorized'); socket.data.user=u; next();} catch{next(new Error('Não autorizado'));}
});
io.on('connection', socket=> {const u=socket.data.user; socket.join(u.role==='admin'?'admins':'workers'); if(u.role==='worker') socket.join(`worker:${u.id}`);});

app.get('/api/health',(_req,res)=>res.json({status:'ok',time:now()}));
app.post('/api/login',rateLimit({windowMs:15*60*1000,limit:20,standardHeaders:'draft-8',legacyHeaders:false}),wrap((req,res)=>{
 const email=str(req.body.email).toLowerCase(); const user=db.prepare('SELECT * FROM users WHERE email=?').get(email);
 if(!user || !user.active || !bcrypt.compareSync(req.body.password||'',user.password_hash)) fail(401,'E-mail ou senha incorretos.');
 const token=jwt.sign({sub:user.id,role:user.role},secret,{expiresIn:'12h',algorithm:'HS256'});
 res.json({token,user:safeUser(user)});
}));
app.get('/api/me',auth,(req,res)=>res.json({user:safeUser(req.user),today:today(),server_time:now()}));

const mailReady=()=>!!(process.env.RESEND_API_KEY&&process.env.OBRAPONTO_EMAIL_FROM);
const emailDigest=(uid,email,nonce,code)=>createHmac('sha256',secret).update(JSON.stringify([uid,email,nonce,code])).digest('hex');
const workerOnly=(req,res,next)=>req.user.role==='worker'?next():res.status(403).json({error:'Somente funcionários.'});
const verificationLimit=rateLimit({windowMs:15*60*1000,limit:60,standardHeaders:'draft-8',legacyHeaders:false});
app.get('/api/worker/email-verification',auth,workerOnly,wrap((req,res)=>{
 const pending=db.prepare('SELECT sent_at FROM email_verification WHERE user_id=?').get(req.user.id);
 res.json({email:req.user.email,verified:!!req.user.email_verified_at,available:mailReady(),retry_after:pending?Math.max(0,Math.ceil((pending.sent_at+60000-Date.now())/1000)):0});
}));
app.post('/api/worker/email-verification/send',auth,workerOnly,verificationLimit,wrap(async(req,res)=>{
 if(!mailReady())fail(503,'Envio de e-mail ainda não configurado. Seu ponto continua disponível.');
 const code=String(randomInt(0,1000000)).padStart(6,'0'),nonce=id(),t=Date.now();
 const destination=db.transaction(()=>{
  const u=db.prepare('SELECT email,email_verified_at FROM users WHERE id=? AND active=1').get(req.user.id);
  if(!u)fail(401,'Sessão inválida.');
  if(u.email_verified_at)fail(409,'E-mail já confirmado.');
  const old=db.prepare('SELECT * FROM email_verification WHERE user_id=?').get(req.user.id);
  if(old&&t-old.sent_at<60000)fail(429,'Aguarde um minuto antes de reenviar.');
  const sameWindow=old&&t-old.window_start<24*60*60*1000;
  const count=sameWindow?old.send_count:0;
  if(count>=5)fail(429,'Limite diário de reenvios atingido. Tente novamente mais tarde.');
  db.prepare('INSERT INTO email_verification (user_id,email,nonce,digest,expires_at,sent_at,window_start,send_count,attempts) VALUES (?,?,?,?,?,?,?,?,0) ON CONFLICT(user_id) DO UPDATE SET email=excluded.email,nonce=excluded.nonce,digest=excluded.digest,expires_at=excluded.expires_at,sent_at=excluded.sent_at,window_start=excluded.window_start,send_count=excluded.send_count,attempts=0').run(req.user.id,u.email,nonce,emailDigest(req.user.id,u.email,nonce,code),t+10*60*1000,t,sameWindow?old.window_start:t,count+1);
  return u.email;
 })();
 try{
  const response=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:'Bearer '+process.env.RESEND_API_KEY,'Content-Type':'application/json','Idempotency-Key':'obraponto-email-'+nonce},body:JSON.stringify({from:process.env.OBRAPONTO_EMAIL_FROM,to:[destination],subject:'ObraPonto — confirme seu e-mail',text:'Seu código de confirmação é '+code+'. Ele expira em 10 minutos. Não compartilhe este código. Se você não solicitou, ignore esta mensagem.'}),signal:AbortSignal.timeout(10000)});
  if(!response.ok)throw Error('Falha do provedor de e-mail.');
 }catch{
  db.prepare('UPDATE email_verification SET expires_at=0,digest=? WHERE user_id=? AND nonce=?').run('',req.user.id,nonce);
  fail(503,'Não foi possível enviar o código. Tente novamente mais tarde.');
 }
 audit(req.user.id,'email_verification_sent',req.user.id);
 res.json({ok:true,expires_in:600,retry_after:60});
}));
app.post('/api/worker/email-verification/confirm',auth,workerOnly,verificationLimit,wrap((req,res)=>{
 const code=typeof req.body.code==='string'?req.body.code.trim():'';
 if(!/^\d{6}$/.test(code))fail(400,'Informe os seis dígitos do código.');
 const result=db.transaction(()=>{
  const u=db.prepare('SELECT email,email_verified_at FROM users WHERE id=? AND active=1').get(req.user.id);
  if(!u)return 'invalid';
  if(u.email_verified_at)return 'verified';
  const c=db.prepare('SELECT * FROM email_verification WHERE user_id=?').get(req.user.id);
  if(!c||c.email!==u.email||c.expires_at<=Date.now()||c.attempts>=5||!/^[a-f0-9]{64}$/.test(c.digest))return 'expired';
  const correct=timingSafeEqual(Buffer.from(c.digest,'hex'),Buffer.from(emailDigest(req.user.id,u.email,c.nonce,code),'hex'));
  if(!correct){
   db.prepare('UPDATE email_verification SET attempts=attempts+1 WHERE user_id=?').run(req.user.id);
   return 'incorrect';
  }
  db.prepare('UPDATE users SET email_verified_at=? WHERE id=? AND email=?').run(now(),req.user.id,u.email);
  db.prepare("UPDATE email_verification SET expires_at=0,digest='' WHERE user_id=?").run(req.user.id);
  audit(req.user.id,'email_verified',req.user.id);
  return 'verified';
 })();
 if(result!=='verified')fail(400,result==='incorrect'?'Código incorreto.':'Código expirado ou indisponível. Solicite outro.');
 changed('workers',req.user.id);res.json({ok:true,verified:true});
}));

app.get('/api/sites',auth,(_req,res)=>res.json({sites:db.prepare('SELECT id,name,city,address,active,created_at FROM sites ORDER BY active DESC,name ASC').all().map(s=>({...s,active:!!s.active}))}));

// V2: dados e preferências da empresa atual. Ainda não é multiempresa.
app.get('/api/company/branding',auth,(_req,res)=>{
 const {trade_name,logo_data_url}=companyProfile();res.json({trade_name,logo_data_url});
});
app.get('/api/admin/company',auth,admin,(_req,res)=>res.json({company:companyProfile()}));
app.patch('/api/admin/company',auth,admin,wrap((req,res)=>{
 const current=companyProfile();
 const field=(key,max)=>req.body[key]===undefined?current[key]:str(req.body[key],max);
 const logo=req.body.logo_data_url===undefined?current.logo_data_url:req.body.logo_data_url;
 if(logo && (typeof logo!=='string'||!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(logo)||Buffer.from(logo.split(',')[1]||'','base64').length>125000))fail(400,'Logo inválida. Use PNG, JPG ou WebP de até 125 KB.');
 const email=field('contact_email',180);
 if(email&&!/^\S+@\S+\.\S+$/.test(email))fail(400,'E-mail inválido.');
 const cnpj=field('cnpj',22);
 if(cnpj&&cnpj.replace(/\D/g,'').length!==14)fail(400,'Informe um CNPJ com 14 dígitos.');
 const wd=req.body.workday_minutes===undefined?current.workday_minutes:Number(req.body.workday_minutes);
 if(!Number.isInteger(wd)||wd<60||wd>900)fail(400,'Jornada de referência deve ficar entre 60 e 900 minutos.');
 const pickBool=key=>req.body[key]===undefined?(current[key]?1:0):(req.body[key]===true?1:0);
 db.prepare('UPDATE company_profile SET legal_name=?,trade_name=?,cnpj=?,contact_email=?,phone=?,address=?,logo_data_url=?,allow_worker_select_site=?,allow_worker_requests=?,workday_minutes=?,updated_at=? WHERE id=1').run(field('legal_name',150),field('trade_name',120),cnpj,email,field('phone',35),field('address',250),logo,pickBool('allow_worker_select_site'),pickBool('allow_worker_requests'),wd,now());
 audit(req.user.id,'company_updated','1');changed('company');res.json({company:companyProfile()});
}));
// Admin: cadastros, alocação diária e relatórios
app.get('/api/admin/workers',auth,admin,(req,res)=>{
 const query=req.query.include_archived==='1'
  ? "SELECT * FROM users WHERE role='worker' ORDER BY (archived_at IS NOT NULL),active DESC,name"
  : "SELECT * FROM users WHERE role='worker' AND archived_at IS NULL ORDER BY active DESC,name";
 res.json({workers:db.prepare(query).all().map(safeUser)});
});
app.post('/api/admin/workers',auth,admin,wrap((req,res)=>{
 const name=required(req.body.name,'Nome'), email=required(req.body.email,'E-mail').toLowerCase();
 const password=req.body.password||''; if(!/^\S+@\S+\.\S+$/.test(email))fail(400,'E-mail inválido.');
 if(password.length<8)fail(400,'Senha deve ter no mínimo 8 caracteres.');
 const uid=id(),photo=workerPhoto(req.body.photo_data_url??''),shift=workerShift(req.body.shift??'unspecified');
 try{db.prepare("INSERT INTO users (id,name,email,phone,employee_code,trade,role,password_hash,created_at,photo_data_url,shift) VALUES (?,?,?,?,?,?,'worker',?,?,?,?)").run(uid,name,email,str(req.body.phone,30),str(req.body.employee_code,30),str(req.body.trade,90),bcrypt.hashSync(password,12),now(),photo,shift);}
 catch(e){if(e.code?.includes('CONSTRAINT'))fail(409,'E-mail já cadastrado.');throw e;}
 audit(req.user.id,'worker_created',uid,name); changed('workers');res.status(201).json({worker:safeUser(db.prepare('SELECT * FROM users WHERE id=?').get(uid))});
}));
app.patch('/api/admin/workers/:id',auth,admin,wrap((req,res)=>{
 const u=db.prepare("SELECT * FROM users WHERE id=? AND role='worker'").get(req.params.id);if(!u)fail(404,'Funcionário não encontrado.');
 if(u.archived_at && req.body.restore!==true)fail(409,'Funcionário arquivado. Restaure-o antes de editar.');
 const name=req.body.name!==undefined?required(req.body.name,'Nome'):u.name;
 const email=req.body.email!==undefined?required(req.body.email,'E-mail').toLowerCase():u.email;
 if(!/^\S+@\S+\.\S+$/.test(email))fail(400,'E-mail inválido.');
 const active=req.body.active===undefined?u.active:(req.body.active?1:0);
 const pass=req.body.password ? bcrypt.hashSync(req.body.password,12) : u.password_hash;
 const photo=req.body.photo_data_url===undefined?u.photo_data_url:workerPhoto(req.body.photo_data_url);
 const shift=req.body.shift===undefined?u.shift:workerShift(req.body.shift);
 if(req.body.password && req.body.password.length<8)fail(400,'Senha deve ter no mínimo 8 caracteres.');
 try {db.prepare('UPDATE users SET name=?,email_verified_at=CASE WHEN email=? COLLATE NOCASE THEN email_verified_at ELSE NULL END,email=?,phone=?,employee_code=?,trade=?,active=?,password_hash=?,archived_at=?,photo_data_url=?,shift=? WHERE id=?').run(name,email,email,req.body.phone===undefined?u.phone:str(req.body.phone,30),req.body.employee_code===undefined?u.employee_code:str(req.body.employee_code,30),req.body.trade===undefined?u.trade:str(req.body.trade,90),active,pass,req.body.restore===true?null:u.archived_at,photo,shift,u.id);}catch(e){if(e.code?.includes('CONSTRAINT'))fail(409,'E-mail já cadastrado.');throw e;}
 audit(req.user.id,'worker_updated',u.id,name);changed('workers',u.id);res.json({ok:true});
}));
// Exclusão segura = arquivamento; acesso revogado, registros históricos preservados.
app.delete('/api/admin/workers/:id',auth,admin,wrap((req,res)=>{
 const u=db.prepare("SELECT id,archived_at FROM users WHERE id=? AND role='worker'").get(req.params.id);
 if(!u)fail(404,'Funcionário não encontrado.');
 if(!u.archived_at){db.prepare('UPDATE users SET active=0,archived_at=? WHERE id=?').run(now(),u.id);audit(req.user.id,'worker_archived',u.id);}
 changed('workers',u.id);res.json({ok:true,archived:true});
}));
app.post('/api/admin/sites',auth,admin,wrap((req,res)=>{
 const name=required(req.body.name,'Nome da obra'),city=required(req.body.city,'Cidade');const sid=id();
 db.prepare('INSERT INTO sites VALUES (?,?,?,?,?,?)').run(sid,name,city,str(req.body.address,200),1,now());
 audit(req.user.id,'site_created',sid,name);changed('sites');res.status(201).json({id:sid});
}));
// Arquivamento reversível; registros de ponto e alocações anteriores permanecem intactos.
const ensureSiteCanArchive=siteId=>{
 if(db.prepare("SELECT 1 FROM assignments a JOIN users u ON u.id=a.worker_id WHERE a.site_id=? AND a.day>=? AND u.active=1 LIMIT 1").get(siteId,today()))fail(409,'Realoque os funcionários com alocação de hoje ou futura antes de arquivar a obra.');
 const recent=db.prepare("SELECT p.* FROM punches p JOIN users u ON u.id=p.user_id WHERE u.active=1 AND p.day>=? ORDER BY p.at,p.rowid").all(dateBR(new Date(Date.now()-86400000)));
 const last=new Map();for(const p of recent)last.set(p.user_id+'|'+p.day,p);
 if([...last.values()].some(p=>p.site_id===siteId&&p.type!=='out'))fail(409,'Há uma jornada em aberto nesta obra. Finalize ou regularize o ponto antes de arquivar.');
};
app.delete('/api/admin/sites/:id',auth,admin,wrap((req,res)=>{
 const site=db.prepare('SELECT * FROM sites WHERE id=?').get(req.params.id);if(!site)fail(404,'Obra não encontrada.');
 if(site.active){ensureSiteCanArchive(site.id);db.prepare('UPDATE sites SET active=0 WHERE id=?').run(site.id);audit(req.user.id,'site_archived',site.id);changed('sites');}
 res.json({ok:true,archived:true});
}));
app.patch('/api/admin/sites/:id',auth,admin,wrap((req,res)=>{
 const s=db.prepare('SELECT * FROM sites WHERE id=?').get(req.params.id);if(!s)fail(404,'Obra não encontrada.');
 if(s.active&&req.body.active===false)ensureSiteCanArchive(s.id);
 db.prepare('UPDATE sites SET name=?,city=?,address=?,active=? WHERE id=?').run(req.body.name===undefined?s.name:required(req.body.name,'Nome da obra'),req.body.city===undefined?s.city:required(req.body.city,'Cidade'),req.body.address===undefined?s.address:str(req.body.address,200),req.body.active===undefined?s.active:(req.body.active?1:0),s.id);
 audit(req.user.id,'site_updated',s.id);changed('sites');res.json({ok:true});
}));
app.get('/api/admin/assignments',auth,admin,(req,res)=>{
 const day=dayParam(req.query.day);
 const rows=db.prepare('SELECT a.*,s.name AS site_name,s.city AS site_city,u.name AS worker_name FROM assignments a JOIN sites s ON s.id=a.site_id JOIN users u ON u.id=a.worker_id WHERE a.day=? ORDER BY u.name').all(day);
 res.json({assignments:rows});
});
const setAssignment=db.prepare('INSERT INTO assignments (worker_id,day,site_id,assigned_by,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(worker_id,day) DO UPDATE SET site_id=excluded.site_id,assigned_by=excluded.assigned_by,updated_at=excluded.updated_at');
app.put('/api/admin/assignments',auth,admin,wrap((req,res)=>{
 const workerId=str(req.body.worker_id,40),siteId=str(req.body.site_id,40),day=dayParam(req.body.day);
 if(!db.prepare("SELECT id FROM users WHERE id=? AND role='worker' AND active=1").get(workerId))fail(404,'Funcionário não encontrado ou inativo.');
 if(!db.prepare('SELECT id FROM sites WHERE id=? AND active=1').get(siteId))fail(404,'Obra não encontrada ou inativa.');
 setAssignment.run(workerId,day,siteId,req.user.id,now());audit(req.user.id,'assignment_changed',workerId,`${day} ${siteId}`);changed('assignments',workerId);res.json({ok:true});
}));

const allPunchesForDay = (userId,day)=>db.prepare('SELECT p.*,s.name AS site_name,s.city AS site_city FROM punches p JOIN sites s ON p.site_id=s.id WHERE p.user_id=? AND p.day=? ORDER BY p.at,p.rowid').all(userId,day);
const allowedTypes = list=> {const last=list.at(-1)?.type;return !last?['in']:last==='in'||last==='break_end'?['break_start','out']:last==='break_start'?['break_end']:[];};

const rectificationSelect='SELECT c.*,s.name AS site_name,s.city AS site_city FROM punch_rectifications c JOIN sites s ON s.id=c.site_id';
const rectificationsForDay=(userId,day)=>db.prepare(rectificationSelect+' WHERE c.user_id=? AND c.day=? ORDER BY c.rowid').all(userId,day);
function applyRectifications(originals,changes){
 const result=new Map(originals.map(p=>[p.id,{...p}]));
 for(const c of changes){
  if(c.action==='void'){result.delete(c.target_id);continue;}
  if(c.action==='adjust'){
   const p=result.get(c.target_id);
   if(p)result.set(p.id,{...p,at:c.corrected_at,rectified:true});
  }else if(c.action==='add'){
   result.set(c.id,{id:c.id,user_id:c.user_id,day:c.day,type:c.type,site_id:c.site_id,site_name:c.site_name,site_city:c.site_city,at:c.corrected_at,created_at:c.created_at,rectified:true,manual:true});
  }
 }
 return [...result.values()].sort((a,b)=>a.at.localeCompare(b.at)||a.id.localeCompare(b.id));
}
function validPunchSequence(list){
 const prior=[];
 for(const p of list){
  if(!allowedTypes(prior).includes(p.type)||(prior.length&&p.at<=prior.at(-1).at))return false;
  prior.push(p);
 }
 return true;
}
function localRectificationTime(day,time){
 if(typeof time!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(time))fail(400,'Informe um horário válido (HH:mm).');
 const format=new Intl.DateTimeFormat('en-GB',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
 const desired=Date.parse(day+'T'+time+':00Z');
 let t=desired;
 for(let i=0;i<4;i++){
  const parts=Object.fromEntries(format.formatToParts(new Date(t)).map(p=>[p.type,p.value]));
  const shown=Date.parse(parts.year+'-'+parts.month+'-'+parts.day+'T'+parts.hour+':'+parts.minute+':00Z');
  if(shown===desired)return new Date(t).toISOString();
  t+=desired-shown;
 }
 fail(400,'Horário local inexistente. Escolha outro horário.');
}
const revisionOf=changes=>changes.at(-1)?.id||'';
const correctionTime=ts=>ts?new Date(ts).toLocaleTimeString('pt-BR',{timeZone:'America/Sao_Paulo',hour:'2-digit',minute:'2-digit'}):'—';
const correctionText=c=>({add:'Inclusão',adjust:'Ajuste',void:'Desconsideração'}[c.action]+' '+({in:'Entrada',break_start:'Início intervalo',break_end:'Fim intervalo',out:'Saída'}[c.type])+' ('+correctionTime(c.previous_at)+' para '+correctionTime(c.corrected_at)+') — '+c.reason+' | Responsável: '+c.actor_name+' | Registrada em '+new Date(c.created_at).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'}));

// A equipe pode selecionar uma obra diferente a cada dia. Mudanças ficam registradas.
app.get('/api/worker/today',auth,wrap((req,res)=>{
 if(req.user.role!=='worker')fail(403,'Somente funcionários.');
 const day=today();const assignment=db.prepare('SELECT a.*,s.name AS site_name,s.city AS site_city FROM assignments a JOIN sites s ON s.id=a.site_id WHERE a.worker_id=? AND a.day=?').get(req.user.id,day)||null;
 const punches=allPunchesForDay(req.user.id,day);
 res.json({day,assignment,punches,allowed_types:allowedTypes(punches),server_time:now()});
}));
app.put('/api/worker/site',auth,wrap((req,res)=>{
 if(req.user.role!=='worker')fail(403,'Somente funcionários.');
 if(!companyProfile().allow_worker_select_site)fail(403,'Somente o administrador pode escolher a obra.');
 const siteId=str(req.body.site_id,40),day=today();
 if(!db.prepare('SELECT id FROM sites WHERE id=? AND active=1').get(siteId))fail(404,'Obra inválida.');
 setAssignment.run(req.user.id,day,siteId,req.user.id,now());audit(req.user.id,'worksite_selected',req.user.id,`${day} ${siteId}`);changed('assignments',req.user.id);res.json({ok:true});
}));
app.post('/api/worker/punch',auth,wrap((req,res)=>{
 if(req.user.role!=='worker')fail(403,'Somente funcionários.');
 const day=today(),siteId=str(req.body.site_id,40),type=str(req.body.type,20);
 if(!db.prepare('SELECT id FROM sites WHERE id=? AND active=1').get(siteId))fail(404,'Selecione uma obra ativa.');
 // Transação impede dupla marcação simultânea e conserva histórico imutável.
 const punch=db.transaction(()=>{
  const previous=allPunchesForDay(req.user.id,day),allowed=allowedTypes(previous);
  if(!allowed.length)fail(409,'Jornada já finalizada hoje.');
  if(!allowed.includes(type))fail(409,'Marcação fora da sequência permitida. Atualize o aplicativo.');
  const p={id:id(),user_id:req.user.id,site_id:siteId,day,type,at:now(),created_at:now()};
  db.prepare('INSERT INTO punches (id,user_id,site_id,day,type,at,created_at) VALUES (@id,@user_id,@site_id,@day,@type,@at,@created_at)').run(p);
  return p;
 })();
 audit(req.user.id,'punch_recorded',punch.id,`${type} ${day} ${siteId}`);changed('punches',req.user.id);res.status(201).json({punch});
}));

function duration(punches, includeOpen=false) {
 let elapsed=0, running=null;
 for(const p of punches){ const t=new Date(p.at).getTime(); if(p.type==='in'||p.type==='break_end'){running=t;}
  else if((p.type==='break_start'||p.type==='out')&&running!==null){elapsed+=Math.max(0,t-running);running=null;}
 }
 if(includeOpen&&running!==null)elapsed+=Math.max(0,Date.now()-running);
 return Math.round(elapsed/60000);
}
function reportRows({from,to,workerId,siteId,allUsers=false}) {
 if(new Date(to).getTime()-new Date(from).getTime()>95*86400000) fail(400,'Selecione um intervalo de no máximo 95 dias.');
 const workers=allUsers ? db.prepare("SELECT id,name,trade,employee_code FROM users WHERE role='worker' ORDER BY name").all() : db.prepare('SELECT id,name,trade,employee_code FROM users WHERE id=?').all(workerId);
 const entries=db.prepare('SELECT p.*,s.name AS site_name,s.city AS site_city FROM punches p JOIN sites s ON s.id=p.site_id WHERE p.day BETWEEN ? AND ? ORDER BY p.user_id,p.day,p.at').all(from,to);
 const assignments=db.prepare('SELECT a.*,s.name AS site_name,s.city AS site_city FROM assignments a JOIN sites s ON a.site_id=s.id WHERE a.day BETWEEN ? AND ?').all(from,to);
 const group=new Map();
 const key=(wid,day)=>`${wid}/${day}`;
 for(const p of entries){const k=key(p.user_id,p.day);if(!group.has(k))group.set(k,{worker_id:p.user_id,day:p.day,punches:[]});group.get(k).punches.push(p);}
 for(const a of assignments){const k=key(a.worker_id,a.day);if(!group.has(k))group.set(k,{worker_id:a.worker_id,day:a.day,punches:[]});group.get(k).assignment=a;}
 const corrections=db.prepare(rectificationSelect+' WHERE c.day BETWEEN ? AND ? ORDER BY c.rowid').all(from,to);
 for(const c of corrections){const k=key(c.user_id,c.day);if(!group.has(k))group.set(k,{worker_id:c.user_id,day:c.day,punches:[]});const g=group.get(k);(g.rectifications??=[]).push(c);}
 let rows=[];
 for(const row of group.values()){
  const u=workers.find(w=>w.id===row.worker_id);if(!u)continue;
  const original_punches=row.punches,rectifications=row.rectifications||[];
  const p=applyRectifications(original_punches,rectifications), last=p.at(-1), site=p[0]||row.assignment||original_punches[0]||rectifications[0];
  if(siteId && !p.some(e=>e.site_id===siteId)&&row.assignment?.site_id!==siteId&&!original_punches.some(e=>e.site_id===siteId)&&!rectifications.some(e=>e.site_id===siteId))continue;
  const minutes=duration(p,row.day===today()&&last?.type!=='out');
  rows.push({worker_id:u.id,worker_name:u.name,trade:u.trade,employee_code:u.employee_code,day:row.day,site_id:site?.site_id||'',site_name:site?.site_name||'—',site_city:site?.site_city||'—',punches:p,original_punches,rectifications,rectified:rectifications.length>0,status:!p.length?'Sem marcação':last.type==='out'?'Concluído':row.day===today()?'Em andamento':'Pendente',minutes});
 }
 rows.sort((a,b)=>b.day.localeCompare(a.day)||a.worker_name.localeCompare(b.worker_name));return rows;
}
// Exportação individual autenticada, inclusive para funcionários arquivados.
app.get('/api/admin/report/export',auth,admin,wrap(async(req,res)=>{
 const workerId=required(req.query.worker_id,'Funcionário',40);
 const worker=db.prepare("SELECT id,name,trade,employee_code FROM users WHERE id=? AND role='worker'").get(workerId);
 if(!worker)fail(404,'Funcionário não encontrado.');
 const from=dayParam(req.query.from,new Date(Date.now()-30*86400000).toISOString().slice(0,10));
 const to=dayParam(req.query.to);
 if(from>to)fail(400,'Data inicial maior que final.');
 const siteId=str(req.query.site_id,40),format=str(req.query.format,6).toLowerCase();
 if(!['pdf','xlsx'].includes(format))fail(400,'Formato inválido. Escolha pdf ou xlsx.');
 const rows=reportRows({from,to,workerId,siteId,allUsers:false});
 const company=companyProfile();const name=company.trade_name||company.legal_name||'ObraPonto';
 const stem=`obraponto_${workerId.slice(0,8)}_${from}_${to}`;
 const total=rows.reduce((a,r)=>a+r.minutes,0);
 if(format==='xlsx'){
  const book=new ExcelJS.Workbook();book.creator='ObraPonto';book.created=new Date();
  const sh=book.addWorksheet('Jornada individual');
  sh.columns=[{width:15},{width:32},{width:30},{width:27},{width:19},{width:19},{width:17},{width:46},{width:46},{width:80}];
  sh.addRow([name]);sh.addRow(['Relatório individual de funcionário']);
  sh.addRow(['Funcionário',worker.name,'Matrícula',worker.employee_code||'—']);
  sh.addRow(['Período',from+' a '+to]);sh.addRow([]);
  const head=sh.addRow(['Data','Funcionário','Obra','Cidade','Situação','Horas decimais','Minutos','Marcações consideradas','Marcações originais','Retificações (auditoria)']);
  head.font={bold:true,color:{argb:'FFFFFFFF'}};head.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF5145A0'}};
  const hm=dt=>new Date(dt).toLocaleTimeString('pt-BR',{timeZone:'America/Sao_Paulo',hour:'2-digit',minute:'2-digit'});
  for(const row of rows)sh.addRow([row.day,row.worker_name,row.site_name,row.site_city,row.status,Number((row.minutes/60).toFixed(2)),row.minutes,row.punches.map(p=>p.type+': '+hm(p.at)+(p.rectified?' [retificada]':'')).join(' | '),row.original_punches.map(p=>p.type+': '+hm(p.at)).join(' | '),row.rectifications.map(correctionText).join('\n')]);
  sh.addRow(['TOTAL','','','','',Number((total/60).toFixed(2)),total]);sh.getRow(sh.rowCount).font={bold:true};
  sh.views=[{state:'frozen',ySplit:6}];
  res.set('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.set('Content-Disposition',`attachment; filename="${stem}.xlsx"`);
  res.send(Buffer.from(await book.xlsx.writeBuffer()));return;
 }
 const doc=new PDFDocument({size:'A4',margin:40,info:{Title:'Relatório individual de jornada - ObraPonto',Author:name}});
 res.set('Content-Type','application/pdf');
 res.set('Content-Disposition',`attachment; filename="${stem}.pdf"`);
 res.set('Cache-Control','private, no-store');
 doc.pipe(res);
 const fmtDate=day=>day.split('-').reverse().join('/');
 const fmtTime=ts=>new Date(ts).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit',timeZone:'America/Sao_Paulo'});
 const fmtHours=minutes=>`${Math.floor(minutes/60)}h${String(minutes%60).padStart(2,'0')}`;
 const titles={in:'Entrada',break_start:'Início intervalo',break_end:'Fim intervalo',out:'Saída'};
 const navy='#102C49',orange='#E87917',muted='#506278',line='#D8E1EA',pale='#F1F5F9';
 const left=40, width=doc.page.width-80, right=left+width;
 const bottom=doc.page.height-102;
 const period=fmtDate(from)+' a '+fmtDate(to);
 let page=1, y=40;
 const font=(size,bold=false,color=navy)=>doc.font(bold?'Helvetica-Bold':'Helvetica').fontSize(size).fillColor(color);
 const textLine=(value,x,top,w,size=10,bold=false,color=navy,align='left')=>{
  font(size,bold,color);
  const opts={width:w,align,lineGap:2};
  const height=doc.heightOfString(String(value),opts);
  doc.text(String(value),x,top,opts);
  return top+height;
 };
 const measure=(value,w,size=10,bold=false)=>{
  font(size,bold);
  return doc.heightOfString(String(value),{width:w,lineGap:2});
 };
 const divider=yy=>doc.strokeColor(line).lineWidth(0.7).moveTo(left,yy).lineTo(right,yy).stroke();
 const footer=()=>{
  const fy=doc.page.height-85;
  divider(fy);
  textLine('Horários no fuso de São Paulo. Relatório operacional para consulta e impressão; não substitui AFD, AEJ ou documentos fiscais exigidos pela legislação trabalhista.',left,fy+7,width-68,8,false,muted);
  textLine('Página '+page,right-65,fy+7,65,8,true,muted,'right');
 };
 const header=first=>{
  y=40;
  doc.rect(left,y,5,28).fill(orange);
  y=textLine('ObraPonto | Controle de jornada',left+13,y+1,width-13,11,true,navy)+5;
  y=textLine(name,left+13,y,width-13,first?19:13,true,navy)+9;
  divider(y);y+=10;
  if(first){
   y=textLine('Relatório individual de jornada',left,y,width,15,true)+8;
   if(company.legal_name)y=textLine('Razão social: '+company.legal_name,left,y,width,9,false,muted)+3;
   if(company.cnpj)y=textLine('CNPJ: '+company.cnpj,left,y,width,9,false,muted)+3;
  }
  y=textLine('Funcionário: '+worker.name,left,y,width,11,true)+4;
  y=textLine('Matrícula: '+(worker.employee_code||'—')+'   |   Função: '+(worker.trade||'—'),left,y,width,10,false,muted)+4;
  y=textLine('Período: '+period,left,y,width,10,false,muted)+10;
  if(first){
   const h=55;
   doc.roundedRect(left,y,width,h,6).fill(pale);
   doc.rect(left,y,4,h).fill(orange);
   textLine('TOTAL TRABALHADO NO PERÍODO',left+13,y+9,width-26,9,true,muted);
   textLine(fmtHours(total),left+13,y+24,width-26,18,true);
   y+=h+14;
  }
  y=textLine('Registros por dia',left,y,width,11,true)+7;
 };
 const nextPage=()=>{footer();doc.addPage();page++;header(false);};
 const ensure=h=>{if(y+h>bottom)nextPage();};
 header(true);
 if(!rows.length){
  ensure(35);
  y=textLine('Nenhum registro de jornada encontrado no período selecionado.',left,y,width,10,false,muted)+12;
 }
 for(const row of rows){
  const date=fmtDate(row.day), summary=date+'  |  '+row.status;
  const site='Obra: '+row.site_name+'  |  Cidade: '+row.site_city;
  const hh=fmtHours(row.minutes);
  const barHeight=Math.max(measure(summary,width-112,10,true),measure(hh,86,11,true))+16;
  const siteHeight=measure(site,width-20,10);
  const marks=row.punches.map(p=>`${titles[p.type]||p.type}: ${fmtTime(p.at)}${p.rectified?' (retificada)':''}`);
  if(!marks.length)marks.push('Sem marcação');
  const groups=[];
  for(let i=0;i<marks.length;i+=4)groups.push(marks.slice(i,i+4).join('  |  '));
  const firstMarkHeight=measure(groups[0],width-20,9);
  ensure(barHeight+siteHeight+firstMarkHeight+28);
  doc.roundedRect(left,y,width,barHeight,4).fill(pale);
  textLine(summary,left+10,y+8,width-112,10,true);
  textLine(hh,right-96,y+7,86,11,true,navy,'right');
  y+=barHeight+7;
  y=textLine(site,left+10,y,width-20,10,false,muted)+5;
  for(let i=0;i<groups.length;i++){
   const h=measure(groups[i],width-20,9)+5;
   if(y+h>bottom){
    nextPage();
    y=textLine(date+' — Continuação das marcações',left+10,y,width-20,10,true)+6;
   }
   y=textLine(groups[i],left+10,y,width-20,9,false,navy)+5;
  }
  if(row.rectified){
   const originals='Originais: '+(row.original_punches.map(p=>(titles[p.type]||p.type)+': '+fmtTime(p.at)).join(' | ')||'Sem marcação');
   const notes=[originals,...row.rectifications.map(correctionText)];
   for(const note of notes){
    const chunks=note.match(/.{1,220}(?:\s|$)|.{1,220}/gu)||[note];
    for(const chunk of chunks){
     const h=measure(chunk,width-20,8)+4;
     if(y+h>bottom){nextPage();y=textLine(date+' — Auditoria da retificação',left+10,y,width-20,10,true)+6;}
     y=textLine(chunk.trim(),left+10,y,width-20,8,false,muted)+4;
    }
   }
  }
  divider(y+2);y+=12;
 }
 ensure(48);
 doc.roundedRect(left,y,width,38,5).fill(pale);
 textLine('TOTAL DO PERÍODO',left+12,y+12,width-130,10,true);
 textLine(fmtHours(total),right-110,y+10,98,13,true,navy,'right');
 footer();
 doc.end();
}));
app.get('/api/worker/history',auth,wrap((req,res)=>{
 if(req.user.role!=='worker')fail(403,'Somente funcionários.');
 const from=dayParam(req.query.from,new Date(Date.now()-30*86400000).toISOString().slice(0,10)),to=dayParam(req.query.to);
 res.json({rows:reportRows({from,to,workerId:req.user.id})});
}));
app.get('/api/admin/report',auth,admin,wrap((req,res)=>{
 const from=dayParam(req.query.from,new Date(Date.now()-14*86400000).toISOString().slice(0,10)),to=dayParam(req.query.to);
 if(from>to)fail(400,'Data inicial maior que final.');
 res.json({rows:reportRows({from,to,siteId:str(req.query.site_id,40),workerId:str(req.query.worker_id,40),allUsers:true}).filter(r=>!req.query.worker_id||r.worker_id===req.query.worker_id)});
}));
app.get('/api/admin/dashboard',auth,admin,wrap((_req,res)=>{
 const day=today();
 const workers=db.prepare("SELECT id,name,trade,active,shift FROM users WHERE role='worker' AND active=1 ORDER BY name").all();
 const assignments=db.prepare('SELECT a.worker_id,a.site_id,s.name AS site_name,s.city AS site_city FROM assignments a JOIN sites s ON s.id=a.site_id WHERE a.day=?').all(day);
 const punches=db.prepare('SELECT p.*,s.name AS site_name,s.city AS site_city FROM punches p JOIN sites s ON p.site_id=s.id WHERE p.day=? ORDER BY p.at').all(day);
 const overview=workers.map(w=>{const own=punches.filter(p=>p.user_id===w.id),last=own.at(-1),assignment=assignments.find(a=>a.worker_id===w.id);const site=last||assignment;return {...w,site_id:site?.site_id||null,site_name:site?.site_name||'Sem obra',site_city:site?.site_city||'',last_type:last?.type||null,last_at:last?.at||null,minutes:duration(own,!!last&&last.type!=='out'),status:!last?'Não iniciou':last.type==='out'?'Finalizado':last.type==='break_start'?'Em intervalo':'Em serviço'};});
 const activity=db.prepare('SELECT p.*,u.name AS worker_name,s.name AS site_name,s.city AS site_city FROM punches p JOIN users u ON u.id=p.user_id JOIN sites s ON s.id=p.site_id ORDER BY p.at DESC LIMIT 12').all();
 res.json({day,overview,activity,stats:{employees:workers.length,present:overview.filter(w=>w.last_type&&w.last_type!=='out').length,completed:overview.filter(w=>w.last_type==='out').length,missing:overview.filter(w=>!w.last_type).length,sites:db.prepare('SELECT COUNT(*) AS n FROM sites WHERE active=1').get().n,punchesToday:punches.length,pendingRequests:db.prepare("SELECT COUNT(*) AS n FROM requests WHERE status='pending'").get().n}});
}));

// Avisos internos individuais; sem envio de dados a provedores de push.
app.post('/api/admin/workers/:id/notices',auth,admin,wrap((req,res)=>{
 const worker=db.prepare("SELECT id FROM users WHERE id=? AND role='worker' AND active=1").get(req.params.id);
 if(!worker)fail(404,'Funcionário ativo não encontrado.');
 const message=required(req.body.message,'Mensagem',1000),noticeId=id();
 db.prepare('INSERT INTO worker_notices(id,worker_id,sender_id,message,created_at) VALUES (?,?,?,?,?)').run(noticeId,worker.id,req.user.id,message,now());
 audit(req.user.id,'worker_notice_sent',noticeId,worker.id);changed('notices',worker.id);res.status(201).json({id:noticeId});
}));
app.get('/api/admin/workers/:id/notices',auth,admin,wrap((req,res)=>{
 res.json({notices:db.prepare('SELECT id,message,created_at,read_at FROM worker_notices WHERE worker_id=? ORDER BY created_at DESC LIMIT 100').all(req.params.id)});
}));
app.get('/api/worker/notices',auth,workerOnly,wrap((req,res)=>{
 res.json({notices:db.prepare('SELECT id,message,created_at,read_at FROM worker_notices WHERE worker_id=? ORDER BY created_at DESC LIMIT 100').all(req.user.id),unread:db.prepare('SELECT COUNT(*) n FROM worker_notices WHERE worker_id=? AND read_at IS NULL').get(req.user.id).n});
}));
app.patch('/api/worker/notices/:id/read',auth,workerOnly,wrap((req,res)=>{
 const notice=db.prepare('SELECT id,read_at FROM worker_notices WHERE id=? AND worker_id=?').get(req.params.id,req.user.id);if(!notice)fail(404,'Aviso não encontrado.');
 if(!notice.read_at){db.prepare('UPDATE worker_notices SET read_at=? WHERE id=? AND worker_id=?').run(now(),notice.id,req.user.id);changed('notices',req.user.id);}
 res.json({ok:true});
}));
// Ordens de serviço: não criam ou alteram marcações de ponto nem alocações.
const orderQuery="SELECT o.*,u.name AS worker_name,s.name AS site_name,s.city AS site_city FROM work_orders o JOIN users u ON u.id=o.worker_id JOIN sites s ON s.id=o.site_id";
app.get('/api/admin/work-orders',auth,admin,wrap((_req,res)=>{
 res.json({orders:db.prepare(orderQuery+' ORDER BY o.number DESC LIMIT 200').all()});
}));
app.post('/api/admin/work-orders',auth,admin,wrap((req,res)=>{
 const workerId=required(req.body.worker_id,'Funcionário',40),siteId=required(req.body.site_id,'Obra',40);
 if(!db.prepare("SELECT id FROM users WHERE id=? AND role='worker' AND active=1").get(workerId))fail(404,'Funcionário ativo não encontrado.');
 if(!db.prepare('SELECT id FROM sites WHERE id=? AND active=1').get(siteId))fail(404,'Obra ativa não encontrada.');
 const title=required(req.body.title,'Título',120),description=required(req.body.description,'Descrição',2000);
 const priority=req.body.priority??'normal',dueDay=str(req.body.due_day,10);
 if(!['normal','high','urgent'].includes(priority))fail(400,'Prioridade inválida.');
 if(dueDay&&(!isDate(dueDay)||new Date(dueDay+'T12:00:00Z').toISOString().slice(0,10)!==dueDay))fail(400,'Prazo inválido.');
 const orderId=id(),stamp=now();
 const order=db.transaction(()=>{
  const result=db.prepare('INSERT INTO work_orders(id,worker_id,site_id,creator_id,title,description,priority,due_day,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(orderId,workerId,siteId,req.user.id,title,description,priority,dueDay,stamp,stamp);
  db.prepare('INSERT INTO worker_notices(id,worker_id,sender_id,message,created_at) VALUES (?,?,?,?,?)').run(id(),workerId,req.user.id,'Nova ordem de serviço #'+result.lastInsertRowid+': '+title,stamp);
  audit(req.user.id,'work_order_created',orderId,workerId);
  return db.prepare(orderQuery+' WHERE o.id=?').get(orderId);
 })();
 changed('orders',workerId);res.status(201).json({order});
}));
app.get('/api/worker/work-orders',auth,workerOnly,wrap((req,res)=>{
 res.json({orders:db.prepare(orderQuery+' WHERE o.worker_id=? ORDER BY o.number DESC LIMIT 200').all(req.user.id)});
}));
app.patch('/api/worker/work-orders/:id/status',auth,workerOnly,wrap((req,res)=>{
 const next=req.body.status,stamp=now();
 const result=db.transaction(()=>{
  const order=db.prepare('SELECT * FROM work_orders WHERE id=? AND worker_id=?').get(req.params.id,req.user.id);
  if(!order)fail(404,'Ordem de serviço não encontrada.');
  const transitions={sent:'accepted',accepted:'in_progress',in_progress:'completed'};
  if(transitions[order.status]!==next||!['accepted','in_progress','completed'].includes(next))fail(409,'Transição de situação inválida.');
  const note=next==='completed'?str(req.body.completion_note,1000):order.completion_note;
  db.prepare('UPDATE work_orders SET status=?,updated_at=?,accepted_at=?,started_at=?,completed_at=?,completion_note=? WHERE id=?').run(next,stamp,next==='accepted'?stamp:order.accepted_at,next==='in_progress'?stamp:order.started_at,next==='completed'?stamp:order.completed_at,note,order.id);
  audit(req.user.id,'work_order_status',order.id,next);
  return {id:order.id,status:next};
 })();
 changed('orders',req.user.id);res.json({order:result});
}));
app.patch('/api/admin/work-orders/:id/cancel',auth,admin,wrap((req,res)=>{
 const workerId=db.transaction(()=>{
  const order=db.prepare('SELECT * FROM work_orders WHERE id=?').get(req.params.id);if(!order)fail(404,'Ordem de serviço não encontrada.');
  if(['completed','cancelled'].includes(order.status))fail(409,'Ordem já encerrada.');
  const stamp=now();
  db.prepare("UPDATE work_orders SET status='cancelled',updated_at=?,cancelled_at=? WHERE id=?").run(stamp,stamp,order.id);
  db.prepare('INSERT INTO worker_notices(id,worker_id,sender_id,message,created_at) VALUES (?,?,?,?,?)').run(id(),order.worker_id,req.user.id,'Ordem de serviço #'+order.number+' cancelada.',stamp);
  audit(req.user.id,'work_order_cancelled',order.id);
  return order.worker_id;
 })();
 changed('orders',workerId);res.json({ok:true});
}));
const requireDocuments=(req,res,next)=>documentsEnabled?next():res.status(503).json({error:'Documentos privados ainda em validação.'});
app.get('/api/documents/config',auth,(_req,res)=>res.json({enabled:documentsEnabled,max_bytes:2000000}));
const docMeta='id,kind,period,mime,created_at,status,reviewed_at';
const readDocumentUpload=(body,kind)=>{
 const raw=body?.data_url;
 if(typeof raw!=='string'||raw.length>2700000||!/^data:(application\/pdf|image\/jpeg|image\/png);base64,[A-Za-z0-9+/]+={0,2}$/.test(raw))fail(400,'Arquivo inválido. Use PDF, JPG ou PNG de até 2 MB.');
 const [header,encoded]=raw.split(','),mime=header.slice(5,-7),bytes=Buffer.from(encoded,'base64');
 if(!bytes.length||bytes.length>2000000||bytes.toString('base64')!==encoded)fail(400,'Arquivo inválido ou acima de 2 MB.');
 const validPdf=mime==='application/pdf'&&bytes.subarray(0,5).toString()==='%PDF-'&&bytes.subarray(-2048).includes(Buffer.from('%%EOF'));
 const validPng=mime==='image/png'&&bytes.length>=24&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))&&bytes.subarray(12,16).toString()==='IHDR';
 const validJpg=mime==='image/jpeg'&&bytes.length>4&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255&&bytes[bytes.length-2]===255&&bytes[bytes.length-1]===217;
 if(!validPdf&&!(kind==='medical'&&(validPng||validJpg)))fail(400,kind==='timesheet'?'Folha de ponto deve ser um PDF válido.':'Formato de documento inválido.');
 return {mime,bytes};
};
const addDocument=(req,res,workerId,kind)=>{
 const {mime,bytes}=readDocumentUpload(req.body,kind);
 const period=kind==='timesheet'?str(req.body.period,7):'';
 if(kind==='timesheet'&&(!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)||period>today().slice(0,7)))fail(400,'Informe uma competência válida, não futura.');
 if(kind==='timesheet'&&req.body.closed!==true)fail(400,'Confirme o fechamento do período antes de disponibilizar a folha.');
 const docId=id(),created=now();
 db.transaction(()=>{
  if(db.prepare('SELECT COUNT(*) n FROM private_documents WHERE uploader_id=? AND created_at>=?').get(req.user.id,new Date(Date.now()-86400000).toISOString()).n>=50)fail(429,'Limite de envios atingido. Tente mais tarde.');
  db.prepare('INSERT INTO private_documents(id,worker_id,uploader_id,kind,period,mime,content,created_at) VALUES (?,?,?,?,?,?,?,?)').run(docId,workerId,req.user.id,kind,period,mime,bytes,created);
  audit(req.user.id,'private_document_uploaded',docId,kind);
 })();
 changed('documents',workerId);res.status(201).json({id:docId});
};
app.get('/api/worker/documents',auth,workerOnly,requireDocuments,wrap((req,res)=>res.json({documents:db.prepare('SELECT '+docMeta+' FROM private_documents WHERE worker_id=? AND kind IN (\'medical\',\'timesheet\') ORDER BY created_at DESC LIMIT 200').all(req.user.id)})));
app.post('/api/worker/documents',auth,workerOnly,requireDocuments,documentJson,wrap((req,res)=>addDocument(req,res,req.user.id,'medical')));
app.get('/api/admin/workers/:id/documents',auth,admin,requireDocuments,wrap((req,res)=>{
 if(!db.prepare("SELECT id FROM users WHERE id=? AND role='worker'").get(req.params.id))fail(404,'Funcionário não encontrado.');
 res.json({documents:db.prepare('SELECT '+docMeta+' FROM private_documents WHERE worker_id=? AND kind IN (\'medical\',\'timesheet\') ORDER BY created_at DESC LIMIT 200').all(req.params.id)});
}));
app.post('/api/admin/workers/:id/documents',auth,admin,requireDocuments,documentJson,wrap((req,res)=>{
 if(!db.prepare("SELECT id FROM users WHERE id=? AND role='worker' AND active=1").get(req.params.id))fail(404,'Funcionário ativo não encontrado.');
 addDocument(req,res,req.params.id,'timesheet');
}));
app.get('/api/documents/:id/download',auth,requireDocuments,wrap((req,res)=>{
 const doc=db.prepare('SELECT * FROM private_documents WHERE id=? AND kind IN (\'medical\',\'timesheet\') AND (?=\'admin\' OR worker_id=?)').get(req.params.id,req.user.role,req.user.id);
 if(!doc)fail(404,'Documento não encontrado.');
 const ext=doc.mime==='application/pdf'?'pdf':doc.mime==='image/png'?'png':'jpg';
 const name=doc.kind==='timesheet'?'folha-de-ponto-'+doc.period:'atestado-'+doc.id.slice(0,8);
 audit(req.user.id,'private_document_downloaded',doc.id,doc.kind);
 res.set('X-Content-Type-Options','nosniff');res.attachment(name+'.'+ext);res.type(doc.mime).send(doc.content);
}));
app.patch('/api/admin/documents/:id/status',auth,admin,requireDocuments,wrap((req,res)=>{
 const doc=db.prepare("SELECT id,worker_id FROM private_documents WHERE id=? AND kind='medical'").get(req.params.id);
 if(!doc)fail(404,'Atestado não encontrado.');
 const status=req.body.status;if(!['reviewed','rejected'].includes(status))fail(400,'Situação inválida.');
 db.prepare('UPDATE private_documents SET status=?,reviewed_at=? WHERE id=?').run(status,now(),doc.id);
 audit(req.user.id,'private_document_reviewed',doc.id,status);changed('documents',doc.worker_id);res.json({ok:true});
}));
app.post('/api/worker/requests',auth,wrap((req,res)=>{
 if(req.user.role!=='worker')fail(403,'Somente funcionários.');
 if(!companyProfile().allow_worker_requests)fail(403,'Novas solicitações estão desativadas.');
 const day=dayParam(req.body.day),message=required(req.body.message,'Justificativa',500);
 const rid=id();db.prepare('INSERT INTO requests (id,user_id,day,message,status,created_at) VALUES (?,?,?,?,?,?)').run(rid,req.user.id,day,message,'pending',now());audit(req.user.id,'correction_requested',rid,day);changed('requests',req.user.id);res.status(201).json({id:rid});
}));
app.get('/api/worker/requests',auth,wrap((req,res)=>{
 if(req.user.role!=='worker')fail(403,'Somente funcionários.');
 res.json({requests:db.prepare('SELECT r.*,EXISTS(SELECT 1 FROM punch_rectifications c WHERE c.request_id=r.id) AS rectified FROM requests r WHERE r.user_id=? ORDER BY r.created_at DESC LIMIT 30').all(req.user.id)});
}));
app.get('/api/admin/requests',auth,admin,(_req,res)=>res.json({requests:db.prepare('SELECT r.*,u.name AS worker_name,EXISTS(SELECT 1 FROM punch_rectifications c WHERE c.request_id=r.id) AS rectified FROM requests r JOIN users u ON r.user_id=u.id ORDER BY (r.status=\'pending\') DESC,r.created_at DESC LIMIT 100').all()}));


const privacyKinds=['access','correction','deletion'];
app.get('/api/privacy/requests',auth,wrap((req,res)=>{
 res.json({requests:db.prepare('SELECT id,kind,message,status,response,created_at,answered_at FROM privacy_requests WHERE user_id=? ORDER BY created_at DESC LIMIT 50').all(req.user.id)});
}));
app.post('/api/privacy/requests',auth,wrap((req,res)=>{
 const kind=str(req.body.kind,20),message=str(req.body.message,1000);
 if(!privacyKinds.includes(kind))fail(400,'Tipo de solicitação inválido.');
 if(message.length<5)fail(400,'Descreva a solicitação.');
 const rid=db.transaction(()=>{
  if(db.prepare("SELECT id FROM privacy_requests WHERE user_id=? AND kind=? AND status IN ('pending','in_review')").get(req.user.id,kind))fail(409,'Já existe uma solicitação deste tipo em atendimento.');
  const rid=id();
  db.prepare('INSERT INTO privacy_requests (id,user_id,kind,message,created_at) VALUES (?,?,?,?,?)').run(rid,req.user.id,kind,message,now());
  audit(req.user.id,'privacy_request_created',rid,kind);
  return rid;
 })();
 changed('privacy',req.user.id);res.status(201).json({id:rid});
}));
app.get('/api/admin/privacy/requests',auth,admin,wrap((_req,res)=>{
 res.json({requests:db.prepare("SELECT p.*,u.name AS user_name FROM privacy_requests p JOIN users u ON u.id=p.user_id ORDER BY (p.status='pending') DESC,p.created_at DESC LIMIT 200").all()});
}));
app.patch('/api/admin/privacy/requests/:id',auth,admin,wrap((req,res)=>{
 const result=db.transaction(()=>{
  const p=db.prepare('SELECT * FROM privacy_requests WHERE id=?').get(req.params.id);
  if(!p)fail(404,'Solicitação não encontrada.');
  if(p.status==='answered')fail(409,'Solicitação já respondida.');
  const status=str(req.body.status,20),response=str(req.body.response,2000);
  if(!['in_review','answered'].includes(status))fail(400,'Situação inválida.');
  if(status==='answered'&&response.length<10)fail(400,'Registre a resposta e as providências adotadas.');
  db.prepare('UPDATE privacy_requests SET status=?,response=?,decided_by=?,answered_at=? WHERE id=?').run(status,response,req.user.id,status==='answered'?now():null,p.id);
  audit(req.user.id,'privacy_request_processed',p.id,status);
  return p;
 })();
 changed('privacy',result.user_id);res.json({ok:true});
}));

app.get('/api/admin/requests/:id/rectification',auth,admin,wrap((req,res)=>{
 const r=db.prepare('SELECT * FROM requests WHERE id=?').get(req.params.id);
 if(!r)fail(404,'Solicitação não encontrada.');
 const originals=allPunchesForDay(r.user_id,r.day),changes=rectificationsForDay(r.user_id,r.day);
 const assignment=db.prepare('SELECT site_id FROM assignments WHERE worker_id=? AND day=?').get(r.user_id,r.day);
 res.json({originals,punches:applyRectifications(originals,changes),rectifications:changes,revision:revisionOf(changes),site_id:assignment?.site_id||originals[0]?.site_id||'',sites:db.prepare('SELECT id,name,city FROM sites ORDER BY name').all(),editable:r.day<today()&&r.status!=='rejected'&&!changes.some(c=>c.request_id===r.id)});
}));
app.post('/api/admin/requests/:id/rectification',auth,admin,wrap((req,res)=>{
 const result=db.transaction(()=>{
  const r=db.prepare('SELECT * FROM requests WHERE id=?').get(req.params.id);
  if(!r)fail(404,'Solicitação não encontrada.');
  if(r.day>=today())fail(409,'Retificação disponível somente para dias anteriores.');
  if(r.status==='rejected')fail(409,'Solicitação recusada. Envie uma nova solicitação.');
  const originals=allPunchesForDay(r.user_id,r.day),changes=rectificationsForDay(r.user_id,r.day);
  if(changes.some(c=>c.request_id===r.id))fail(409,'Esta solicitação já foi retificada.');
  if(typeof req.body.revision!=='string'||req.body.revision!==revisionOf(changes))fail(409,'O histórico foi alterado. Reabra o formulário.');
  const effective=applyRectifications(originals,changes);
  const action=str(req.body.action,10),reason=str(req.body.reason,500);
  if(!['add','adjust','void'].includes(action))fail(400,'Ação inválida.');
  if(reason.length<5)fail(400,'Informe uma justificativa com pelo menos 5 caracteres.');
  const target=action==='add'?null:effective.find(p=>p.id===str(req.body.target_id,40));
  if(action!=='add'&&!target)fail(404,'Marcação não encontrada.');
  const type=target?.type||str(req.body.type,20),site_id=target?.site_id||str(req.body.site_id,40);
  if(!['in','break_start','break_end','out'].includes(type))fail(400,'Tipo de marcação inválido.');
  const site=db.prepare('SELECT id,name,city FROM sites WHERE id=?').get(site_id);
  if(!site)fail(400,'Selecione uma obra válida.');
  const corrected_at=action==='void'?null:localRectificationTime(r.day,req.body.time);
  if(action==='adjust'&&correctionTime(target.at)===req.body.time)fail(400,'Informe um horário diferente do atual.');
  const c={id:id(),request_id:r.id,user_id:r.user_id,day:r.day,action,target_id:target?.id||null,type,site_id,previous_at:target?.at||null,corrected_at,reason,actor_id:req.user.id,actor_name:req.user.name,created_at:now()};
  const proposed=applyRectifications(effective,[{...c,site_name:site.name,site_city:site.city}]);
  if(!validPunchSequence(proposed))fail(400,'A retificação deixaria as marcações fora da sequência válida. Confira os horários e tipos.');
  db.prepare('INSERT INTO punch_rectifications (id,request_id,user_id,day,action,target_id,type,site_id,previous_at,corrected_at,reason,actor_id,actor_name,created_at) VALUES (@id,@request_id,@user_id,@day,@action,@target_id,@type,@site_id,@previous_at,@corrected_at,@reason,@actor_id,@actor_name,@created_at)').run(c);
  db.prepare("UPDATE requests SET status='reviewed',admin_note=?,decided_at=? WHERE id=?").run('Retificação registrada.',c.created_at,r.id);
  audit(req.user.id,'punch_rectified',c.id,JSON.stringify({request_id:r.id,action,day:r.day}));
  return c;
 })();
 changed('punches',result.user_id);changed('requests',result.user_id);
 res.status(201).json({ok:true,rectification:result});
}));

app.patch('/api/admin/requests/:id',auth,admin,wrap((req,res)=>{
 const r=db.prepare('SELECT * FROM requests WHERE id=?').get(req.params.id);if(!r)fail(404,'Solicitação não encontrada.');
 if(db.prepare('SELECT id FROM punch_rectifications WHERE request_id=?').get(r.id))fail(409,'Solicitação já retificada.');
 const status=str(req.body.status);if(!['reviewed','rejected'].includes(status))fail(400,'Status inválido.');
 db.prepare('UPDATE requests SET status=?,admin_note=?,decided_at=? WHERE id=?').run(status,str(req.body.admin_note,300),now(),r.id);
 audit(req.user.id,'request_reviewed',r.id,status);changed('requests',r.user_id);res.json({ok:true});
}));

const dist=path.join(here,'web','dist');
if(fs.existsSync(dist)){
 const sendAdmin=(_req,res)=>res.sendFile(path.join(dist,'admin','index.html'));
 const sendWorker=(_req,res)=>res.sendFile(path.join(dist,'funcionario','index.html'));
 app.get(['/admin','/admin/','/admin/index.html'],sendAdmin);
 app.get(['/funcionario','/funcionario/','/funcionario/index.html'],sendWorker);
 app.use(express.static(dist,{index:false,redirect:false}));
}
app.use((err,req,res,_next)=>{if((err.status||500)>=500)console.error(err);res.status(err.status||500).json({error:err.status?err.message:'Erro interno do servidor.'});});
const port=Number(process.env.PORT)||3001;
http.listen(port,()=>console.log(`ObraPonto: http://localhost:${port}/admin/ e http://localhost:${port}/funcionario/`));
