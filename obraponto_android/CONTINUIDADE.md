# ObraPonto — protocolo de continuidade
Atualizado em 27/11/2026.
Quando o titular disser BACKUP, gerar um arquivo de continuidade atualizado para download. Registrar versões, branches e commits, estado de implantação, testes (separar comprovados de pendentes), pendências conferidas na Play Console para Empresa e Colaboradores, decisões e próxima ação. Não incluir credenciais, chaves de assinatura, JWT ou dados pessoais reais. Um resumo não substitui o backup do código-fonte, dos bancos nem das chaves; guardar estes separadamente em armazenamento privado.
Não alterar produção durante o desenvolvimento. Conferir o estado real do painel e dos testes antes de marcar tarefas concluídas.

## Verificação de email — 1.4.0
No ambiente de desenvolvimento monoempresa, funcionário confirma o endereço cadastrado por código de seis dígitos, validade dez minutos, cinco tentativas por código, intervalo mínimo de um minuto e cinco envios por 24 horas. Alteração do endereço invalida a confirmação. O ponto continua disponível mesmo sem email confirmado ou provedor disponível. Administrador visualiza o status.
Para ativar envio no ambiente de teste, configurar exclusivamente nas variáveis privadas do Railway: RESEND_API_KEY e OBRAPONTO_EMAIL_FROM (remetente de domínio verificado). Não incluir valores no GitHub. Testar entrega real com conta fictícia e depois revisar declarações de privacidade e segurança de dados. O teste automatizado usa código fictício e não envia email real. Portar o recurso ao futuro servidor SaaS após recuperação e teste da base comercial.

## Play Console — revisão de capturas arquivadas em 27/11/2026
Evidência de 26/11/2026 (horário Brasília), não consulta ao painel ao vivo.
- Empresa: 104858.png às 13:47 mostrava 8/11; 105803.png às 21:17 confirma 10/11. Concluídos: política de privacidade, detalhes do login, anúncios, classificação, público-alvo, apps governamentais, recursos financeiros, saúde, categoria e contato, página de detalhes. Única tarefa inicial pendente: segurança dos dados.
- Colaboradores: 105927.png às 22:22 e 105935.png às 22:31 confirmam 9/11. Concluídos os mesmos itens exceto página de detalhes do app. Pendentes: segurança dos dados e página de detalhes. 105929.png mostra descrições preenchidas; 105933.png mostra alterações salvas mas capturas ainda ausentes. Não considerar ficha concluída.
- Colaboradores: 105806.png às 21:25 e 105936.png às 22:33 confirmam teste interno ativo na versão 130 (1.3.0) e lista Testadores ObraPonto com dois usuários; não significa dois inscritos no teste fechado.
- 105898.png mostra classificação e segurança de dados em atenção; 105899.png mostra classificação IARC atual concluída (Brasil Livre) e questionário adicional incompleto. 105935.png posterior marca classificação concluída no painel. Conferir rascunho duplicado sem reiniciar classificação válida.
- Ambos ainda sem produção pública. Teste fechado e solicitação de acesso à produção são etapas posteriores, separadas das 11 tarefas iniciais.
- Próximo passo Play: confirmar situação atual, finalizar Segurança dos dados de ambos conforme versão final e completar ficha Colaboradores com recursos reais. Rever declarações apenas quando comportamento mudar (ex.: privacidade e verificação de email). Não repetir formulários já concluídos.

## Checkpoint BACKUP — 27/11/2026, 10:05 BRT
- Colaboradores: Segurança dos dados preenchida e salva (prints 106898/106899), painel 10/11. Ainda não enviada à revisão; validar exceções de compartilhamento, fluxos de localização/dados e política pública antes do envio. Empresa: última evidência 10/11, segurança dos dados pendente.
- Ficha Colaboradores: nome e descrições já preenchidos; ícone PNG 512x512 e recurso gráfico PNG 1024x500 inseridos, print 106912. Ficha ainda não finalizada. Próximo passo: fechar painel lateral de recursos e adicionar capturas reais do telefone (login, ponto, histórico e solicitações), avançar e salvar. Depois finalizar segurança dos dados Empresa e revisar visuais. Não repetir formulários concluídos.
- Versão 1.4.0: última evidência Actions 09:27 mostra teste PDF/retificação/privacidade #6 aprovado e build Android #2 em andamento. Testes adicionais de email e artefatos finais ainda a confirmar; envio real de email, SaaS comercial, isolamento multiempresa e testes em aparelhos pendentes. Não alterar produção.
- Arquivo local de continuidade: ObraPonto_BACKUP_2026-11-27.md; ZIP inclui manual, ícone, banner e sete evidências Play Console. Não é backup integral de código, banco ou chaves; guardar separadamente em local privado.
