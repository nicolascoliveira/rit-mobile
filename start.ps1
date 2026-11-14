Write-Host "==============================================================" -ForegroundColor Cyan
Write-Host "                 INICIANDO ECOSSISTEMA RIT                    " -ForegroundColor Cyan
Write-Host "==============================================================" -ForegroundColor Cyan

Write-Host "[1/3] Iniciando API Backend (Porta 3000)..." -ForegroundColor Yellow
Start-Process powershell -WindowStyle Minimized -ArgumentList "-NoExit", "-Command", "Set-Location '$PSScriptRoot\api'; node --env-file=../.env server.js"

Write-Host "[2/3] Iniciando App de Treino do Aluno (Porta 8080)..." -ForegroundColor Yellow
Start-Process powershell -WindowStyle Minimized -ArgumentList "-NoExit", "-Command", "Set-Location '$PSScriptRoot\frontend'; npm run dev"

Write-Host "[3/3] Iniciando Portal de Gestao & Academia (Porta 8081)..." -ForegroundColor Yellow
Start-Process powershell -WindowStyle Minimized -ArgumentList "-NoExit", "-Command", "Set-Location '$PSScriptRoot\portal'; npm run dev"

Write-Host "Aguardando 3 segundos para os servicos subirem..." -ForegroundColor Yellow
Start-Sleep -Seconds 3

Write-Host "Abrindo aplicacoes no navegador..." -ForegroundColor Green
Start-Process "http://localhost:8081"
Start-Process "http://localhost:8080/?tenant=ironpower"

Write-Host "==============================================================" -ForegroundColor Green
Write-Host " - Central de Gestao (Rit Admin & Academias): http://localhost:8081" -ForegroundColor Green
Write-Host " - Aplicativo de Treino do Aluno:             http://localhost:8080/?tenant=ironpower" -ForegroundColor Green
Write-Host "==============================================================" -ForegroundColor Green
