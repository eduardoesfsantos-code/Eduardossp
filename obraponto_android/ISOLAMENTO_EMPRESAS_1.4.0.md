# Isolamento de empresas — ObraPonto 1.4.0

## Escopo proposto para piloto
Uma empresa por instância de servidor, banco SQLite, volume persistente, segredo JWT e URL HTTPS próprios. Não é SaaS multiempresa em banco compartilhado; os endpoints atuais não possuem filtros tenant_id. Não compartilhar o banco, o volume, as chaves ou o acesso administrativo entre clientes. Não usar a homologação como servidor comercial. Não provisionar recursos pagos sem autorização.

## Teste automatizado
test-company-isolation.mjs cria duas instâncias temporárias com bancos separados, credenciais fictícias e segredos aleatórios. Verifica autenticação cruzada, WebSocket, cadastro, obras, avisos, documentos, ordens, registros de ponto e notificações. Não usa e-mail real nem dados de clientes. Executado pelo workflow de validação 1.4.0. Aprovação depende do resultado do GitHub Actions.

## Antes do primeiro cliente
- Validar custo e capacidade do ambiente dedicado, segregação de permissões, DNS/HTTPS, segredo exclusivo, backup externo criptografado e restauração testada.
- Testar a seleção e persistência da URL no Android e Windows, sem troca inadvertida de empresa, sem armazenar senha em texto claro.
- Validar e-mail com domínio próprio verificado, privacidade e exclusão de dados, segurança e acesso a documentos sensíveis, alternativa de marcação quando o e-mail falhar.
- Revisar requisitos da Portaria MTP 671/2021 e LGPD com profissionais competentes, incluindo registros, comprovantes e arquivos exigidos; não declarar conformidade antes de concluir.
- Testar jornada noturna, virada do dia e demais regras, atualização Android assinada, publicação Play Console e suporte.
- SaaS compartilhado, caso desejado: projeto separado com identificação de tenant server-side, autenticação e autorização por empresa, isolamento de todas as consultas, arquivos, eventos, relatórios, backups e migração; testes adversariais independentes antes de liberar.

Nenhum cliente real, serviço pago ou ambiente de produção foi alterado por esta etapa.

## Backup e recuperação
O utilitário `backup-encrypted.mjs` cria snapshot SQLite consistente com VACUUM INTO, verifica integridade e cifra com AES-256-GCM usando uma chave aleatória de 32 bytes, exclusiva por empresa, mantida separada do backup. A restauração valida a autenticação do arquivo e a integridade SQLite e só escreve em novo caminho. Não substitui banco ativo. A chave deve ser provisionada fora do repositório; não reutilizar JWT_SECRET.
Uso local controlado (variável OBRAPONTO_BACKUP_KEY já configurada de forma segura): `node backup-encrypted.mjs backup /caminho/banco.sqlite /destino/novo-backup.enc`; `node backup-encrypted.mjs restore /destino/novo-backup.enc /recuperacao/novo.sqlite`.
O teste usa apenas armazenamento externo simulado em diretório temporário. Não há envio remoto, agendamento, política de retenção ou garantia de recuperação de desastre no Railway. Ainda é necessário escolher armazenamento separado do volume, configurar acesso mínimo e transferência automática, monitorar falhas, manter cópias da chave em custódia segura e testar restauração em instância independente. Limites do utilitário: processamento integral em memória e arquivo SQLite temporário em área privada; avaliar espaço, tamanho e descarte seguro antes de usar com dados reais.

## Backup local manual — candidato
Empresa > Configurações > Backup local da empresa: opção com flag OBRAPONTO_LOCAL_BACKUP=1, autenticação administrativa e confirmação da senha atual, senha de backup exclusiva de 16–128 caracteres, derivação scrypt (salt aleatório) e AES-256-GCM. Arquivo .enc até 8 MiB, histórico da última geração (não confirma que o aparelho salvou), sem upload ou restauração via HTTP. O suporte restaura em caminho novo com `node backup-encrypted.mjs restore-local ORIGEM DESTINO` e variável privada OBRAPONTO_LOCAL_BACKUP_PASSWORD; validar identidade da empresa e autorização antes de recuperar. Perda da senha implica perda de acesso à cópia. Não enviar o arquivo nem a senha em chat. 
Colaborador > Meu ponto > Salvar meus registros (CSV): usa API do próprio usuário e período selecionado; não é uma cópia completa da empresa nem arquivo oficial de fiscalização. Folhas de ponto continuam disponíveis na área de documentos.
Validar testes do GitHub e salvamento real Android/Windows; a ponte Android antiga trata extensões desconhecidas como CSV, portanto revisar MIME application/octet-stream para .enc na próxima compilação nativa. Não habilitar para dados reais antes de revisar acesso a documentos sensíveis, armazenamento externo, retenção e restauração segura. O limite de 8 MiB é provisório para compatibilidade e consumo de memória; não atende todos os clientes.
