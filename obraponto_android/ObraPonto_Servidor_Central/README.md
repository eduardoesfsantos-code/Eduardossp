# ObraPonto — Controle de ponto por obra

**Versão 1.0 — dois aplicativos web instaláveis (PWA) e um servidor central.**

- **Gestão:** `/admin/` — painel administrativo, equipe, obras, designação diária, atividade ao vivo, solicitações e exportação CSV.
- **Funcionário:** `/funcionario/` — entrada, intervalo opcional, retorno, saída, troca de obra, histórico pessoal, justificativas e perfil.
- **Servidor:** Node.js + Express + SQLite, Socket.IO para sincronização instantânea entre dispositivos conectados. Histórico de marcações imutável na interface.

## Começar no computador (Windows, macOS ou Linux)

**Pré-requisito:** Node.js LTS 22 ou mais recente, com internet na primeira instalação das dependências.

1. Extraia o ZIP e abra um terminal na pasta `obraponto`.
2. Execute `npm run setup` para criar o administrador e gerar um segredo privado automaticamente (a senha digitada fica visível no terminal). Alternativamente, copie `.env.example` para `.env` e preencha os dados manualmente.
3. Instale as dependências: `npm install`.
4. Inicie o sistema de desenvolvimento: `npm run dev`.
5. No navegador, abra:
   - **Admin:** http://localhost:5173/admin/
   - **Funcionário:** http://localhost:5173/funcionario/

Entre como administrador com as credenciais do `.env`. Cadastre a primeira obra (por exemplo, **Supermercado Cotia / Cotia**) em **Obras e locais**. Em seguida, cadastre os funcionários com nome, e-mail, função, telefone, matrícula e senha. Cada funcionário entra no aplicativo Funcionário com o e-mail e a senha cadastrados.

**Prévia sem instalação:** abra `previa_offline.html` no navegador. É uma demonstração local com dados fictícios, sem servidor e sem sincronização entre dispositivos.

**Importante:** O administrador inicial é criado somente se não houver nenhum administrador no banco. Alterar `ADMIN_PASSWORD` no `.env` depois da primeira inicialização não troca automaticamente a senha já criada.

## Criar versão para hospedagem

```bash
npm install
npm run build
npm start
```

Após o build, o servidor hospeda **os dois aplicativos**:

- http://localhost:3001/admin/
- http://localhost:3001/funcionario/

Para pessoas em **celulares diferentes** verem as mesmas informações, publique **este servidor em um endereço HTTPS acessível por todos** (VPS, serviço Node.js com disco persistente etc.). Ambos devem apontar para **a mesma instância de servidor e o mesmo banco**. No telefone, abra o endereço HTTPS correspondente e use o menu do navegador para **Adicionar à tela inicial / Instalar aplicativo**. As duas PWAs têm nomes, ícones e escopos de instalação independentes. **Não são APKs nativos**.

### Hospedagem e proteção

- Garanta HTTPS via proxy reverso, firewall, backups e volume permanente para a pasta `data/`.
- SQLite atende uma equipe pequena em uma instância; para escala e alta disponibilidade, migre para PostgreSQL.
- Use segredos fortes, controle o acesso aos backups, mantenha Node e dependências atualizados.
- Confirme regras de autenticação, retenção de dados, permissões e privacidade antes de cadastrar informações reais.
- A hora é definida pelo servidor para evitar alterações no relógio do celular.
- Ponto **exige internet**; **não** há marcação offline/filas nesta versão.
- O sistema utiliza fuso fixo `America/Sao_Paulo` e jornada diária. Turnos que atravessam a meia-noite e escalas complexas pedem adaptação adicional.

## Funcionalidades incluídas

| Área | Funcionalidades |
| --- | --- |
| Acesso | Login individual para administrador e funcionário, senha com hash bcrypt, token de 12 horas, papéis de acesso |
| Cadastro | Funcionários, função, matrícula, telefone, e-mail, situação e senha; obras com local, cidade e endereço |
| Alocação | Obra por pessoa e por **dia**; funcionário pode alterar local do dia, com audit trail |
| Ponto | Entrada, intervalo opcional, retorno, saída; impede sequência inválida ou dupla marcação; horário do servidor |
| Painel | Resumo diário, pessoas em serviço, concluídos, pendentes, atividade ao vivo, gráfico semanal |
| Histórico | Funcionário vê somente as próprias marcações; administração visualiza equipe inteira |
| Relatórios | Filtro por data, funcionário e obra; horas úteis descontando intervalos; CSV UTF-8 |
| Solicitações | Funcionário envia justificativa; administrador analisa ou recusa, preservando o ponto original |
| Sincronização | Socket.IO envia aviso de alteração e cada aplicativo atualiza os dados autorizados em tempo real |
| Instalação | Duas PWAs instaláveis por links próprios, com ícones e manifestos separados |

## Segurança e legislação brasileira

Este é um **MVP operacional**, **não** uma solução certificada REP-P e **não deve ser usado como único sistema oficial de ponto trabalhista** sem análise técnica, jurídica e adequação à **Portaria MTP 671/2021** e à **LGPD**. Para uso formal faltam, conforme o enquadramento: requisitos específicos de REP-P, atestado técnico/termo de responsabilidade, geração de AFD/AEJ, comprovantes fiscais assinados, assinaturas e obrigações de fiscalização, tratamento de ajustes e turnos noturnos. Os relatórios CSV aqui são **gerenciais**, não arquivos AFD/AEJ. Não prometa conformidade normativa antes dessa etapa.

Referências oficiais: [Portaria 671 e REP no MTE](https://www.gov.br/trabalho-e-emprego/pt-br/assuntos/inspecao-do-trabalho/fiscalizacao-do-trabalho/rep) e [Perguntas e Respostas REP](https://www.gov.br/trabalho-e-emprego/pt-br/assuntos/inspecao-do-trabalho/fiscalizacao-do-trabalho/Perguntas%20e%20Respostas%20REP).

## Estrutura

```
obraponto/
  server.js                  # API, autenticação, SQLite e WebSocket
  setup.mjs                  # Assistente de configuração inicial
  previa_offline.html        # Demonstração interativa sem dependências
  .env.example               # Variáveis de configuração
  package.json               # Dependências e comandos
  web/
    vite.config.js
    admin/index.html         # Aplicativo do gestor
    funcionario/index.html   # Aplicativo do funcionário
    src/main.jsx             # Interfaces React, formulários e relatórios
    src/style.css            # Identidade visual responsiva
    public/admin/            # Manifesto, ícones e SW do admin
    public/funcionario/      # Manifesto, ícones e SW do funcionário
```

## Limitações conhecidas desta primeira versão

- **Não oferece APK pronto**, hospedagem gratuita automática nem domínio publicado.
- Requer a configuração inicial do ambiente e a primeira instalação de pacotes via `npm install`.
- Não implementa recebimento de marcações offline, múltiplos turnos por data, banco de horas/horas extras regulatórias, georreferência ou assinatura digital.
- **Analisar uma solicitação não altera registros**; mudanças formais necessitam fluxo de retificação com auditoria e requisitos legais.
- Administração inicial criada por configuração; futura edição da própria senha por interface ainda não implementada.
