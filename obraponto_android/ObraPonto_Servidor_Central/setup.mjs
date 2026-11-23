import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const file=path.join(path.dirname(fileURLToPath(import.meta.url)),'.env');
if(existsSync(file)){
 console.log('O arquivo .env já existe. Para não substituir credenciais, a configuração foi interrompida.');
 process.exit(0);
}
const rl=createInterface({input,output});
try{
 console.log('\n=== ObraPonto | Configuração do primeiro acesso ===');
 console.log('Dica: ao digitar a senha no terminal, ela ficará visível na tela. Proteja seu computador.\n');
 const name=(await rl.question('Nome do administrador [Administrador]: ')).trim()||'Administrador';
 const email=(await rl.question('E-mail do administrador: ')).trim().toLowerCase();
 if(!/^\S+@\S+\.\S+$/.test(email))throw Error('Informe um e-mail válido.');
 const password=await rl.question('Senha de acesso (mínimo 12 caracteres): ');
 if(password.length<12)throw Error('A senha deve ter pelo menos 12 caracteres.');
 if(/[\r\n]/.test(name+email+password))throw Error('Dados inválidos.');
 const escape=s=>JSON.stringify(s);
 const content=`PORT=3001\nJWT_SECRET=${randomBytes(48).toString('hex')}\nADMIN_EMAIL=${email}\nADMIN_PASSWORD=${escape(password)}\nADMIN_NAME=${escape(name)}\nDB_PATH=./data/obraponto.sqlite\n`;
 writeFileSync(file,content,{encoding:'utf8',mode:0o600,flag:'wx'});
 console.log('\nConfiguração gravada com sucesso no arquivo .env.\nPróximos comandos: npm install e npm run dev\n');
}catch(e){console.error('\nErro:',e.message);process.exitCode=1;}finally{rl.close();}
