@echo off
chcp 65001 >nul
cd /d "%~dp0server"
echo Reinitialisation du PIN d'un gerant
echo.
node --disable-warning=ExperimentalWarning src\reset-pin.js
echo.
pause
