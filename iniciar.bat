@echo off
title Transmissao Igreja
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js nao encontrado. Instale em https://nodejs.org (versao LTS) e rode de novo.
  pause
  exit /b 1
)
if not exist node_modules (
  echo Instalando dependencias pela primeira vez...
  call npm install --no-audit --no-fund
)
echo.
echo Iniciando o servidor. Deixe esta janela aberta durante o culto.
echo Para abrir a mesa: http://localhost:8080/mesa
echo.
start "" http://localhost:8080/
node server.js
pause
