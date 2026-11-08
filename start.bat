@echo off
title SpotTransfer - Migrador de Playlists Spotify

echo ======================================================
echo    SpotTransfer - Iniciar Servidor Local
echo ======================================================
echo.

set "NODE_CMD="

where node >nul 2>nul
if %errorlevel% equ 0 (
    set "NODE_CMD=node"
    goto node_found
)

if exist "C:\Program Files\nodejs\node.exe" (
    set "NODE_CMD=C:\Program Files\nodejs\node.exe"
    set "PATH=C:\Program Files\nodejs;%PATH%"
    goto node_found
)

if exist "C:\Program Files (x86)\nodejs\node.exe" (
    set "NODE_CMD=C:\Program Files (x86)\nodejs\node.exe"
    set "PATH=C:\Program Files (x86)\nodejs;%PATH%"
    goto node_found
)

if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" (
    set "NODE_CMD=%LOCALAPPDATA%\Programs\nodejs\node.exe"
    set "PATH=%LOCALAPPDATA%\Programs\nodejs;%PATH%"
    goto node_found
)

echo [ERROR] No se pudo encontrar Node.js automaticamente.
echo Por favor reinicia tu PC o cierra y vuelve a abrir tus ventanas para actualizar el PATH.
echo.
pause
exit /b 1

:node_found
echo [OK] Node.js detectado exitosamente:
"%NODE_CMD%" -v
echo.

cd /d "%~dp0"
echo Iniciando aplicacion web en http://127.0.0.1:3000 ...
"%NODE_CMD%" "%~dp0server.js"
pause
