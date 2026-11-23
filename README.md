# ObraPonto — Publicação dos 2 apps Android + servidor

Este repositório reúne três projetos originais do ObraPonto e acrescenta uma
**automação do GitHub Actions** para compilar dois APKs de teste e um **Dockerfile**
para o servidor em uma hospedagem Docker como Railway.

> **Não está publicado nem compilado ainda.** Nenhum APK ou hospedagem está incluído.

## APKs Android

Envie esta pasta a um repositório GitHub e, após o push, abra **Actions → Gerar
APKs de teste do ObraPonto** (a compilação começa automaticamente ao enviar ao ramo `main`; também há Run workflow). Depois de uma execução bem-sucedida,
baixe separadamente os artefatos `ObraPonto-Empresa-APK` e
`ObraPonto-Funcionario-APK`. Cada arquivo compactado de artefato contém um
`app-debug.apk` e cada APK tem um identificador de pacote Android diferente.

Esse método precisa da conta GitHub, de acesso ao Android SDK no runner e de
uma compilação bem-sucedida. Não foram feitos testes em celulares reais.

## Servidor online (Railway)

Crie um projeto Railway conectado ao mesmo repositório. O `Dockerfile` da raiz
instala dependências Node.js, compila os dois frontends React e inicia o servidor.

No serviço Railway, anexe um **volume persistente com caminho `/data`** e defina
estas variáveis em **Variables** (não salve senhas em arquivos versionados):

- `JWT_SECRET`: chave aleatória, exclusiva e forte (64+ caracteres recomendados)
- `ADMIN_EMAIL`: seu e-mail administrativo
- `ADMIN_PASSWORD`: senha inicial forte (mínimo de 12 caracteres)
- `ADMIN_NAME`: nome do administrador
- `DB_PATH`: `/data/obraponto.sqlite`
- `NODE_ENV`: `production`

Em **Networking**, habilite um domínio HTTPS público. Verifique:

- `https://DOMINIO/api/health` — deve retornar `status: ok`.
- `https://DOMINIO/admin/` — interface Empresa.
- `https://DOMINIO/funcionario/` — interface Funcionário.

Nos dois APKs, configure a mesma **origem HTTPS**, sem `/admin` ou `/funcionario`
no final. Ex.: `https://meu-servidor.up.railway.app`.

**Atenção:** sem o volume, o banco SQLite pode ser perdido após nova publicação.
Acompanhe custos, configure backups, teste controle de acesso e privacidade.
O software está em estágio MVP gerencial, não REP-P homologado.

## Testes de sintaxe realizados localmente

- `node --check` em `server.js` e `setup.mjs`.
- Verificação da estrutura ZIP e dos dois identificadores Android.

**Não realizados:** `npm install`, `npm run build`, compilação APK, teste de
sincronização em dois celulares e publicação online (o ambiente atual não possui
Android SDK nem conexão de rede para baixar dependências).

**Atenção:** O repositório `eduardoesfsantos-code/Eduardossp` estava público na verificação de 23/11/2026. Altere para privado antes de enviar os arquivos se quiser manter o código fechado.
