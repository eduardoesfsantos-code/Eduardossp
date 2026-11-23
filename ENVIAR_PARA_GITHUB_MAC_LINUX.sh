#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
repo='https://github.com/eduardoesfsantos-code/Eduardossp.git'
if [ ! -d .git ]; then git init; fi
git branch -M main
if git remote get-url origin >/dev/null 2>&1; then git remote set-url origin "$repo"; else git remote add origin "$repo"; fi
git add -A
if ! git diff --cached --quiet; then git commit -m 'Publicar projetos ObraPonto e automacao APK'; fi
git push -u origin main
echo 'Codigo enviado; abra GitHub > Actions para obter os dois APKs.'
