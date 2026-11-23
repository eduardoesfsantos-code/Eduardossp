import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
export default defineConfig({
 root,
 plugins:[react()],
 publicDir:path.join(root,'public'),
 build:{outDir:path.join(root,'dist'),emptyOutDir:true,rollupOptions:{input:{admin:path.join(root,'admin/index.html'),funcionario:path.join(root,'funcionario/index.html')}}},
 server:{host:'0.0.0.0',port:5173,proxy:{'/api':'http://localhost:3001','/socket.io':{target:'http://localhost:3001',ws:true}}}
});
