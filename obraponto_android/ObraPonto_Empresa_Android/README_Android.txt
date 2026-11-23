ObraPonto Empresa — aplicativo Android (projeto fonte v1.0)

Este arquivo NÃO é um APK compilado. É um projeto Android Studio separado,
com ícone próprio, login próprio e rota de acesso /admin/.

COMO GERAR O APK NO COMPUTADOR
1. Instale Android Studio atualizado, incluindo Android SDK 35 e JDK 17.
2. Em Android Studio, escolha Open e selecione ESTA pasta.
3. Aguarde a sincronização Gradle, aceitando instalar as dependências necessárias.
4. Menu: Build > Build Bundle(s) / APK(s) > Build APK(s).
5. O APK de testes aparecerá em app/build/outputs/apk/debug/app-debug.apk.
6. Transfira para o Android e autorize a instalação de apps dessa origem.

ANTES DE USAR:
- Publique o backend ObraPonto em um endereço HTTPS acessível.
- Ao abrir o app, informe APENAS o domínio: https://ponto.suaempresa.com.br
- Configure esse MESMO domínio no outro aplicativo.
- Login é validado pelo servidor: contas de empresa só entram na Empresa,
  contas de funcionário só entram no Funcionário.
- Sincronização em tempo real requer a API e banco central ativos.
- Sem servidor online, o app não registra pontos.

O Android Studio precisa de internet para instalar Gradle, Android SDK e o plugin.
Este projeto não contém o Android SDK, nem um APK de testes assinado.
O código-fonte não foi compilado aqui pois esse ambiente não possui Android SDK.

Para produção: gere APK/AAB de release assinado com chave privada própria
no Android Studio (Build > Generate Signed Bundle / APK).

A aplicação web original é servida pelo backend central. O Android oferece
uma interface nativa de conexão, WebView protegido e exportação CSV para arquivos
no app Empresa. Dados e autenticação ficam no servidor.
