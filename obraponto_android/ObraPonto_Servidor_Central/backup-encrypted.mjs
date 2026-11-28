// Backup manual autenticado. Execute em ambiente confiável com chave privada independente.
import Database from 'better-sqlite3';
import {randomBytes,createCipheriv,createDecipheriv} from 'node:crypto';
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
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 const [mode,source,destination]=process.argv.slice(2);
 try{
  if(!source||!destination||!['backup','restore'].includes(mode))throw Error('Uso: node backup-encrypted.mjs backup|restore ORIGEM DESTINO');
  (mode==='backup'?createEncryptedBackup:restoreEncryptedBackup)(source,destination,process.env.OBRAPONTO_BACKUP_KEY);
  console.log(mode==='backup'?'BACKUP_CRIPTOGRAFADO_OK':'RESTAURACAO_VALIDADA_OK');
 }catch(e){console.error('Falha: '+e.message);process.exitCode=1;}
}
