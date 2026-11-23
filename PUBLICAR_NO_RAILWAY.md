# ObraPonto — publicação no Railway

O ObraPonto ainda **não está online**. Este arquivo documenta a configuração para instalar o servidor e conectar os dois APKs Android.

## Etapas no Railway

1. Entre em https://railway.com/new e selecione **Deploy from GitHub repo**.
2. Escolha `eduardoesfsantos-code/Eduardossp` com **Root Directory = /**, para usar o `Dockerfile` e o `railway.json` deste repositório.
3. No serviço, configure as variáveis **privadas**, sem publicá-las neste repositório:
   - `NODE_ENV=production`
   - `DB_PATH=/data/obraponto.sqlite`
   - `JWT_SECRET`: valor aleatório e privado, com 64 ou mais caracteres
   - `ADMIN_EMAIL`: e-mail da administração
   - `ADMIN_PASSWORD`: senha de administração forte com pelo menos 12 caracteres
   - `ADMIN_NAME`: nome da administração
4. Adicione um **volume persistente** ao serviço, montado em `/data`. Isso é essencial: o SQLite precisa conservar os registros depois de reinicializações e novos deploys.
5. Em **Networking → Public Networking**, gere um domínio HTTPS para o serviço.
6. Confira `https://SEU-DOMINIO/api/health` (deve responder com `status: ok`), `https://SEU-DOMINIO/admin/` e `https://SEU-DOMINIO/funcionario/`.
7. Nos dois aplicativos Android já instalados, configure **a mesma origem HTTPS**, por exemplo `https://SEU-DOMINIO.up.railway.app`, sem `/admin` ou `/funcionario` no final.

## Avisos importantes

- Não coloque dados pessoais ou senhas no repositório ou nas mensagens do chat.
- Adicione backups do volume/banco de dados; a existência de um volume não substitui backups.
- Utilize apenas **uma instância** do servidor enquanto estiver usando SQLite local.
- Verifique o plano e a cobrança Railway antes de confirmar a contratação.
- O ObraPonto é uma versão de teste. Não há homologação ou validação para utilização como registro eletrônico oficial de jornada. É necessário avaliar conformidade com a legislação trabalhista e LGPD antes de utilizar com funcionários reais.
