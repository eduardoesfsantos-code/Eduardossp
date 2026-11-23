# ObraPonto — servidor implantado

**Status (23/11/2026):** Railway indica uma implantação bem-sucedida (**SUCCESS**) e serviço **Online**, com 1/1 instância e zero falhas recentes.

- Servidor HTTPS: https://obraponto-servidor-production.up.railway.app
- Verificação de saúde: https://obraponto-servidor-production.up.railway.app/api/health
- Painel Empresa (web): https://obraponto-servidor-production.up.railway.app/admin/
- Painel Funcionário (web): https://obraponto-servidor-production.up.railway.app/funcionario/
- Serviço Railway: `obraponto-servidor`
- Projeto Railway: `graceful-purpose`
- Banco SQLite: `/data/obraponto.sqlite`
- Volume Railway: `obraponto-dados`, 500 MB, montado em `/data`.
- Conta administrativa inicial provisionada por variável de ambiente privada.
- Chave JWT guardada nas variáveis do Railway, nunca no GitHub.

## Teste em celulares

1. Instale o APK Empresa em um aparelho Android e o APK Funcionário no outro.
2. Se o aplicativo pedir o endereço do servidor, use a origem HTTPS acima **sem** `/admin` nem `/funcionario`.
3. Faça login na conta administrativa usando as credenciais privadas fornecidas diretamente ao administrador (não estão neste repositório).
4. No painel da empresa, cadastre uma obra e um funcionário com senha única, atribua a obra do dia.
5. Faça login no aparelho do funcionário, registre entrada e confirme a atualização no painel administrativo.

## Atenção

A infraestrutura Railway está online, mas este documento **não certifica** testes end-to-end com celulares físicos ou conformidade de registro eletrônico oficial de jornada. É necessário configurar backups e revisar requisitos da LGPD e da legislação trabalhista antes de usar registros reais. A hospedagem pode ter custos.
