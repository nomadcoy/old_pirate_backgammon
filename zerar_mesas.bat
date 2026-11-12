@echo off
chcp 65001 >nul
cd /d "%~dp0"
title OLD PIRATE GAMMON - zerar mesas

echo.
echo ==============================================================
echo   OLD PIRATE GAMMON  ::  zerar mesas
echo ==============================================================
echo.
echo Encerrando o servidor na porta 5000...

powershell -NoProfile -ExecutionPolicy Bypass -Command "$c = Get-NetTCPConnection -LocalPort 5000 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) { $p = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $c.OwningProcess) -ErrorAction SilentlyContinue; if ($p -and $p.CommandLine -like '*app.py*') { Stop-Process -Id $c.OwningProcess -Force; Write-Host 'Servidor encerrado.' } else { Write-Host 'A porta 5000 esta ocupada por outro processo; nao vou encerra-lo.' } } else { Write-Host 'Nenhum servidor estava na porta 5000.' }"

ping -n 2 127.0.0.1 >nul

echo.
echo Iniciando um servidor limpo...
start "OLD PIRATE GAMMON - servidor" cmd /k "python app.py"

echo.
echo Aguardando o servidor...
ping -n 3 127.0.0.1 >nul
start "" "http://127.0.0.1:5000/?sair=1"

echo.
echo Pronto: mesas zeradas e tela de login aberta.
ping -n 4 127.0.0.1 >nul
exit /b 0
