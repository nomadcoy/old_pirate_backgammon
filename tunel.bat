@echo off
chcp 65001 >nul
cd /d "%~dp0"
title OLD PIRATE GAMMON - tunel publico

set "CF=C:\Program Files (x86)\cloudflared\cloudflared.exe"
if not exist "%CF%" (
  where cloudflared >nul 2>nul
  if errorlevel 1 (
    echo.
    echo cloudflared nao encontrado.
    echo Instale com: winget install --id Cloudflare.cloudflared -e
    echo.
    pause
    exit /b 1
  )
  set "CF=cloudflared"
)

powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort 5000 -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"
if errorlevel 1 (
  echo.
  echo O servidor do jogo nao esta rodando na porta 5000.
  echo Inicie com iniciar.bat ou pelo Agendador de Tarefas.
  echo.
  pause
  exit /b 1
)

echo.
echo ==============================================================
echo   OLD PIRATE GAMMON  ::  tunel publico (Cloudflare)
echo ==============================================================
echo.
echo Copie o endereco https://....trycloudflare.com que aparecer abaixo.
echo Mantenha esta janela aberta enquanto o tunel estiver em uso.
echo Ctrl+C encerra o tunel.
echo.

"%CF%" tunnel --url http://127.0.0.1:5000 --no-autoupdate
echo.
echo Tunel encerrado.
pause
