# Envie o codigo pelo PowerShell em um computador com Git instalado.
$ErrorActionPreference = "Stop"
$repo = "https://github.com/eduardoesfsantos-code/Eduardossp.git"
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw "Instale o Git para Windows: https://git-scm.com/downloads/win" }
Set-Location $PSScriptRoot
if (-not (Test-Path ".git")) { git init }
git branch -M main
if ((git remote) -contains "origin") { git remote set-url origin $repo } else { git remote add origin $repo }
git add -A
git diff --cached --quiet
if ($LASTEXITCODE -ne 0) { git commit -m "Publicar projetos ObraPonto e automacao APK" }
if ($LASTEXITCODE -ne 0) { throw "Falha no commit. Configure Git user.name e user.email." }
git push -u origin main
if ($LASTEXITCODE -ne 0) { throw "Falha no push. Verifique autenticacao do GitHub ou possiveis alteracoes remotas." }
Write-Host "Codigo enviado. Abra GitHub > Actions > Gerar APKs de teste do ObraPonto." -ForegroundColor Green
