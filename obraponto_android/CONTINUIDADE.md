# ObraPonto — protocolo de continuidade
Atualizado em 27/11/2026.
Quando o titular disser BACKUP, gerar um arquivo de continuidade atualizado para download. Registrar versões, branches e commits, estado de implantação, testes (separar comprovados de pendentes), pendências conferidas na Play Console para Empresa e Colaboradores, decisões e próxima ação. Não incluir credenciais, chaves de assinatura, JWT ou dados pessoais reais. Um resumo não substitui o backup do código-fonte, dos bancos nem das chaves; guardar estes separadamente em armazenamento privado.
Não alterar produção durante o desenvolvimento. Conferir o estado real do painel e dos testes antes de marcar tarefas concluídas.

## Verificação de email — 1.4.0
No ambiente de desenvolvimento monoempresa, funcionário confirma o endereço cadastrado por código de seis dígitos, validade dez minutos, cinco tentativas por código, intervalo mínimo de um minuto e cinco envios por 24 horas. Alteração do endereço invalida a confirmação. O ponto continua disponível mesmo sem email confirmado ou provedor disponível. Administrador visualiza o status.
Para ativar envio no ambiente de teste, configurar exclusivamente nas variáveis privadas do Railway: RESEND_API_KEY e OBRAPONTO_EMAIL_FROM (remetente de domínio verificado). Não incluir valores no GitHub. Testar entrega real com conta fictícia e depois revisar declarações de privacidade e segurança de dados. O teste automatizado usa código fictício e não envia email real. Portar o recurso ao futuro servidor SaaS após recuperação e teste da base comercial.
