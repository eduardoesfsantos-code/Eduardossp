# Publicação ObraPonto

## Status

GitHub conectado e primeiro commit criado. Ainda é necessário enviar os diretórios completos dos projetos.

## Código do projeto

O pacote `ObraPonto_PRONTO_PARA_GITHUB_E_APKs.zip` foi entregue na conversa ChatGPT e contém:

- `obraponto_android/ObraPonto_Empresa_Android` — projeto Android da empresa;
- `obraponto_android/ObraPonto_Funcionario_Android` — projeto Android do funcionário;
- `obraponto_android/ObraPonto_Servidor_Central` — API e interfaces web;
- `.github/workflows/gerar-apks.yml` — configuração para gerar APKs no GitHub Actions;
- `Dockerfile` — configuração de hospedagem.

**Não publicar senhas, CPFs, registros de ponto ou outros dados de funcionários neste repositório.**

## Servidor

O Railway ainda precisa ser conectado. Usar HTTPS, `JWT_SECRET`, credenciais administrativas fortes e volume permanente para SQLite (`DB_PATH=/data/obraponto.sqlite`). O protótipo não está homologado como sistema oficial de registro eletrônico de ponto.
