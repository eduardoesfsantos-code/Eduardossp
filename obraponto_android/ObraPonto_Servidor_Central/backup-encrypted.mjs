// Backup manual autenticado. Execute em ambiente confiável com chave privada independente.
import Database from 'better-sqlite3';
import {randomBytes,createCipheriv,createDecipheriv,scryptSync} from 'node:crypto';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,existsSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const magic=Buffer.from('OBRAPONTO-BACKUP-1\n');
const keyBytes=key=>{
 if(typeof key!=='string'||!/^[0-9a-f]{64}$/i.test(key))throw Error('Configure OBRAPONTO_BACKUP_KEY com 32 bytes aleatórios em hexadecimal.');
 return Buffer.from(key,'hex');
};
const check=file=>{
 const db=new Database(file,{readonly:true,fileMustExist:true});
 try{
  if(db.pragma('integrity_check',{simple:true})!=='ok'||db.pragma('foreign_key_check').length)throw Error('Banco não passou na verificação de integridade.');
  for(const table of ['users','punches','sites','company_profile','private_documents','audit']){
   if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))throw Error('Banco ObraPonto incompleto.');
  }
 }finally{db.close();}
};
export function createEncryptedBackup(source,destination,key){
 const secret=keyBytes(key);
 if(existsSync(destination))throw Error('O destino já existe. Escolha um novo arquivo.');
 const temp=mkdtempSync(path.join(tmpdir(),'obraponto-backup-'));
 try{
  const snapshot=path.join(temp,'snapshot.sqlite'),db=new Database(source,{readonly:true,fileMustExist:true});
  try{db.prepare('VACUUM INTO ?').run(snapshot);}finally{db.close();}
  chmodSync(snapshot,0o600);check(snapshot);
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',secret,iv);
  cipher.setAAD(magic);
  const encrypted=Buffer.concat([cipher.update(readFileSync(snapshot)),cipher.final()]);
  writeFileSync(destination,Buffer.concat([magic,iv,cipher.getAuthTag(),encrypted]),{flag:'wx',mode:0o600});
 }finally{rmSync(temp,{recursive:true,force:true});secret.fill(0);}
}
export function restoreEncryptedBackup(source,destination,key){
 const secret=keyBytes(key);
 if(existsSync(destination)||existsSync(destination+'-wal')||existsSync(destination+'-shm'))throw Error('Restaure somente em um caminho novo, nunca sobre um banco ativo.');
 const temp=mkdtempSync(path.join(tmpdir(),'obraponto-restore-'));
 try{
  const raw=readFileSync(source),n=magic.length;
  if(raw.length<=n+28||!raw.subarray(0,n).equals(magic))throw Error('Formato de backup inválido.');
  const decipher=createDecipheriv('aes-256-gcm',secret,raw.subarray(n,n+12));decipher.setAAD(magic);decipher.setAuthTag(raw.subarray(n+12,n+28));
  const plaintext=Buffer.concat([decipher.update(raw.subarray(n+28)),decipher.final()]);
  const candidate=path.join(temp,'restored.sqlite');
  writeFileSync(candidate,plaintext,{flag:'wx',mode:0o600});check(candidate);
  writeFileSync(destination,plaintext,{flag:'wx',mode:0o600});
  plaintext.fill(0);
 }finally{rmSync(temp,{recursive:true,force:true});secret.fill(0);}
}
// Formato local com senha própria, salt aleatório e KDF scrypt. Limite conservador para o Android.
const localMagic=Buffer.from('OBRAPONTO-LOCAL-1\n');
export const LOCAL_BACKUP_LIMIT=8*1024*1024;
const passwordKey=(password,salt)=>{
 if(typeof password!=='string'||password.length<16||password.length>128||Buffer.byteLength(password)>512)throw Error('Use uma senha de backup com 16 a 128 caracteres.');
 return scryptSync(password,salt,32,{N:65536,r:8,p:1,maxmem:96*1024*1024}).toString('hex');
};
export function createPasswordBackup(source,password){
 const db=new Database(source,{readonly:true,fileMustExist:true});
 try{if(db.pragma('page_count',{simple:true})*db.pragma('page_size',{simple:true})>LOCAL_BACKUP_LIMIT)throw Error('Banco acima do limite local. Solicite backup ao suporte.');}finally{db.close();}
 const temp=mkdtempSync(path.join(tmpdir(),'obraponto-local-'));
 try{
  const salt=randomBytes(16),file=path.join(temp,'backup.enc');
  createEncryptedBackup(source,file,passwordKey(password,salt));
  const data=Buffer.concat([localMagic,salt,readFileSync(file)]);
  if(data.length>LOCAL_BACKUP_LIMIT)throw Error('Backup acima do limite local.');
  return data;
 }finally{rmSync(temp,{recursive:true,force:true});}
}
export function restorePasswordBackup(source,destination,password){
 const data=readFileSync(source),n=localMagic.length;
 if(data.length>LOCAL_BACKUP_LIMIT||data.length<=n+16||!data.subarray(0,n).equals(localMagic))throw Error('Backup local inválido.');
 const temp=mkdtempSync(path.join(tmpdir(),'obraponto-local-recovery-'));
 try{
  const file=path.join(temp,'backup.enc');writeFileSync(file,data.subarray(n+16),{flag:'wx',mode:0o600});
  restoreEncryptedBackup(file,destination,passwordKey(password,data.subarray(n,n+16)));
 }finally{rmSync(temp,{recursive:true,force:true});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 const [mode,source,destination]=process.argv.slice(2);
 try{
  if(!source||!destination||!['backup','restore','restore-local'].includes(mode))throw Error('Uso: node backup-encrypted.mjs backup|restore|restore-local ORIGEM DESTINO');
  if(mode==='restore-local')restorePasswordBackup(source,destination,process.env.OBRAPONTO_LOCAL_BACKUP_PASSWORD);
  else (mode==='backup'?createEncryptedBackup:restoreEncryptedBackup)(source,destination,process.env.OBRAPONTO_BACKUP_KEY);
  console.log(mode==='backup'?'BACKUP_CRIPTOGRAFADO_OK':'RESTAURACAO_VALIDADA_OK');
 }catch(e){console.error('Falha: '+e.message);process.exitCode=1;}
}
