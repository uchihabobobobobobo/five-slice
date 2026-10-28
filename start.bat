@echo off
setlocal
cd /d "%~dp0"

if "%PORT%"=="" set PORT=4175
echo.
echo   FIVE / SLICE  -  starting at http://localhost:%PORT%
echo   Press Ctrl+C to stop.
echo.

node server.js
if errorlevel 1 (
  echo.
  echo Could not start the server. Check that Node.js 20+ is installed and port %PORT% is free.
  pause
)
