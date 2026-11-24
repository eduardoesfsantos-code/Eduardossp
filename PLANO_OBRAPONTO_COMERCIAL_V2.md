# ObraPonto Comercial V2 — Desenvolvimento
A versão atual em produção (ramo main) é **monoempresa** e permanece inalterada.
Esta ramificação está reservada para a evolução comercial; **não publicar na produção** até os testes, backup e migração de dados.

## Funcionalidades Empresa solicitadas
- Relatório individual por funcionário com período, obra, total de horas e marcações, exportado em **PDF** e **Excel (.xlsx)**.
- Excluir funcionário de modo seguro: **arquivar e bloquear o login** preservando o histórico e a possibilidade de restauração.
- Cadastro da empresa: nome fantasia, razão social, CNPJ, contatos, endereço, logotipo.
- Configurações: permissão para funcionário alterar obra do dia, solicitações, jornada de referência.

## Arquitetura para comercialização
- Dois apps Android: Empresa (gerenciamento e compra do plano) e Funcionário (gratuito para a equipe).
- Windows: painel web responsivo/PWA antes de empacotar em .exe.
- Único serviço central, mas **cada empresa como tenant independente**.
- Banco PostgreSQL com isolamento por tenant_id em todas as operações, auditoria, backups testados.
- Cadastro autoatendido, verificação de e-mail, recuperação de senha, convites, cobrança por Google Play Billing e validação das assinaturas no servidor.
- Painel do proprietário para contratos, planos e status, sem expor jornada de outros clientes.
- LGPD e avaliação de conformidade de controle de ponto oficial (REP-P / Portaria 671).

## Segurança e publicação
- Antes de colocar a V2 online: testes automáticos de isolamento entre empresas, teste Android/Windows, backups + recuperação, revisão da segurança, declaração de privacidade.
- Repositório atualmente público: considerar torná-lo privado antes da divulgação comercial.
- Não colocar senhas ou chaves na base versionada. Credencial administrativa inicial exposta em conversa deve ser trocada.

O pacote V2 de desenvolvimento com código é mantido separadamente enquanto aguardamos validação. **Não confundir este planejamento com aplicativo comercial já lançado.**
