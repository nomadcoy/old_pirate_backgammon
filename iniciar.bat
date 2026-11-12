@echo off
chcp 65001 >nul
cd /d "%~dp0"
title OLD PIRATE GAMMON - servidor

where python >nul 2>nul
if errorlevel 1 (
  echo.
  echo [ERRO] Python nao encontrado no PATH.
  echo Instale Python 3.10+ em https://python.org
  echo e marque a opcao "Add python.exe to PATH".
  echo.
  pause
  exit /b 1
)

python -c "import flask, flask_socketio, simple_websocket, gevent" >nul 2>nul
if errorlevel 1 (
  echo.
  echo Instalando dependencias...
  python -m pip install -r requirements.txt
  if errorlevel 1 (
    echo.
    echo [ERRO] Nao foi possivel instalar as dependencias.
    pause
    exit /b 1
  )
)

powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort 5000 -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"
if not errorlevel 1 (
  echo.
  echo O servidor ja esta rodando na porta 5000.
  start "" "http://127.0.0.1:5000"
  exit /b 0
)

echo.
echo ==============================================================
echo   OLD PIRATE GAMMON  ::  iniciando o servidor na porta 5000
echo   local: http://127.0.0.1:5000
echo   rede:  o endereco LAN aparece no painel do jogo
echo ==============================================================
echo.
echo   Deixe esta janela aberta enquanto estiver jogando.
echo   Ctrl+C encerra o servidor.
echo.

python app.py
echo.
echo Servidor encerrado.
pause
