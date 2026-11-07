@echo off
title SpotTransfer - Migrador de Playlists Spotify

echo ======================================================
echo    SpotTransfer - Iniciar Servidor Local
echo ======================================================
echo.

if exist "C:\Program Files\nodejs\node.exe" goto use_program_files
if exist "C:\Program Files (x86)\nodejs\node.exe" goto use_program_files_x86
if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" goto use_local_appdata

where node >nul 2>nul
if %errorlevel% equ 0 goto use_path

echo [ERROR] No se pudo encontrar Node.js.
echo Por favor reinicia tu computadora para que Windows reconozca Node.js.
echo.
pause
exit /b 1

:use_program_files
set "PATH=C:\Program Files\nodejs;%PATH%"
set "NODE_BIN=C:\Program Files\nodejs\node.exe"
goto start_server

:use_program_files_x86
set "PATH=C:\Program Files (x86)\nodejs;%PATH%"
set "NODE_BIN=C:\Program Files (x86)\nodejs\node.exe"
goto start_server

:use_local_appdata
set "PATH=%LOCALAPPDATA%\Programs\nodejs;%PATH%"
set "NODE_BIN=%LOCALAPPDATA%\Programs\nodejs\node.exe"
goto start_server

:use_path
set "NODE_BIN=node"
goto start_server

:start_server
echo Node.js detectado: %NODE_BIN%
echo Iniciando aplicacion web en http://127.0.0.1:3000 ...
echo.
"%NODE_BIN%" "%~dp0server.js"
pause
