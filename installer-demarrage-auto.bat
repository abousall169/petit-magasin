@echo off
chcp 65001 >nul
title Installer le demarrage automatique de la caisse

rem --- Demande les droits administrateur (necessaires pour demarrer avant l'ouverture de session et ouvrir le pare-feu)
net session >nul 2>&1
if %errorlevel% neq 0 (
  echo Demande des droits administrateur...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

cd /d "%~dp0"
echo.
echo  La caisse va demarrer toute seule avec ce PC (meme apres une coupure de courant).
echo.
choice /c ON /m "Empecher la mise en veille du PC sur secteur (recommande pour un serveur) "
set SLEEP=
if %errorlevel%==1 set SLEEP=-PreventSleep

powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\install-autostart.ps1" -Mode Boot %SLEEP%
echo.
pause
