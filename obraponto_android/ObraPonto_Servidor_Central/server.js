import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
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
const safeUser = u => u && ({id:u.id,name:u.name,email:u.email,phone:u.phone,employee_code:u.employee_code,trade:u.trade,role:u.role,active:!!u.active,created_at:u.created_at,archived_at:u.archived_at||null});
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
app.use(express.json({limit:'256kb'}));
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
 if(resource==='sites') io.to('workers').emit('changed',{resource});
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
app.get('/api/sites',auth,(_req,res)=>res.json({sites:db.prepare('SELECT id,name,city,address,active,created_at FROM sites ORDER BY active DESC,name ASC').all().map(s=>({...s,active:!!s.active}))}));

// V2: dados e preferências da empresa atual. Ainda não é multiempresa.
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
 const uid=id();
 try{db.prepare("INSERT INTO users (id,name,email,phone,employee_code,trade,role,password_hash,created_at) VALUES (?,?,?,?,?,?,'worker',?,?)").run(uid,name,email,str(req.body.phone,30),str(req.body.employee_code,30),str(req.body.trade,90),bcrypt.hashSync(password,12),now());}
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
 if(req.body.password && req.body.password.length<8)fail(400,'Senha deve ter no mínimo 8 caracteres.');
 try {db.prepare('UPDATE users SET name=?,email=?,phone=?,employee_code=?,trade=?,active=?,password_hash=?,archived_at=? WHERE id=?').run(name,email,req.body.phone===undefined?u.phone:str(req.body.phone,30),req.body.employee_code===undefined?u.employee_code:str(req.body.employee_code,30),req.body.trade===undefined?u.trade:str(req.body.trade,90),active,pass,req.body.restore===true?null:u.archived_at,u.id);}catch(e){if(e.code?.includes('CONSTRAINT'))fail(409,'E-mail já cadastrado.');throw e;}
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
app.patch('/api/admin/sites/:id',auth,admin,wrap((req,res)=>{
 const s=db.prepare('SELECT * FROM sites WHERE id=?').get(req.params.id);if(!s)fail(404,'Obra não encontrada.');
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
 const workers=db.prepare("SELECT id,name,trade,active FROM users WHERE role='worker' AND active=1 ORDER BY name").all();
 const assignments=db.prepare('SELECT a.worker_id,a.site_id,s.name AS site_name,s.city AS site_city FROM assignments a JOIN sites s ON s.id=a.site_id WHERE a.day=?').all(day);
 const punches=db.prepare('SELECT p.*,s.name AS site_name,s.city AS site_city FROM punches p JOIN sites s ON p.site_id=s.id WHERE p.day=? ORDER BY p.at').all(day);
 const overview=workers.map(w=>{const own=punches.filter(p=>p.user_id===w.id),last=own.at(-1),assignment=assignments.find(a=>a.worker_id===w.id);const site=last||assignment;return {...w,site_name:site?.site_name||'Sem obra',site_city:site?.site_city||'',last_type:last?.type||null,last_at:last?.at||null,minutes:duration(own,!!last&&last.type!=='out'),status:!last?'Não iniciou':last.type==='out'?'Finalizado':last.type==='break_start'?'Em intervalo':'Em serviço'};});
 const activity=db.prepare('SELECT p.*,u.name AS worker_name,s.name AS site_name,s.city AS site_city FROM punches p JOIN users u ON u.id=p.user_id JOIN sites s ON s.id=p.site_id ORDER BY p.at DESC LIMIT 12').all();
 res.json({day,overview,activity,stats:{employees:workers.length,present:overview.filter(w=>w.last_type&&w.last_type!=='out').length,completed:overview.filter(w=>w.last_type==='out').length,missing:overview.filter(w=>!w.last_type).length,sites:db.prepare('SELECT COUNT(*) AS n FROM sites WHERE active=1').get().n,punchesToday:punches.length,pendingRequests:db.prepare("SELECT COUNT(*) AS n FROM requests WHERE status='pending'").get().n}});
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
