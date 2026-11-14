@echo off
title Rit Launcher
echo ==============================================================
echo                 INICIANDO ECOSSISTEMA RIT
echo ==============================================================
echo.
echo [1/3] Iniciando API Backend (Porta 3000)...
start "Rit API" /min cmd /k "cd /d %~dp0api && node --env-file=../.env server.js"

echo [2/3] Iniciando App do Aluno - Mobile (Porta 8080)...
start "Rit App Aluno" /min cmd /k "cd /d %~dp0frontend && npm run dev"

echo [3/3] Iniciando Portal de Gestao e Academia (Porta 8081)...
start "Rit Portal" /min cmd /k "cd /d %~dp0portal && npm run dev"

echo.
echo Aguardando inicializacao dos servicos...
timeout /t 3 /nobreak >nul

echo Abrindo o Portal e o App do Aluno no navegador...
start http://localhost:8081
start http://localhost:8080

echo.
echo ==============================================================
echo  - Portal de Gestao / Painel:  http://localhost:8081
echo  - App de Treino do Aluno:     http://localhost:8080
echo ==============================================================
