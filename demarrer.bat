@echo off
chcp 65001 >nul
cd /d "%~dp0"

rem --- Deja en marche (par exemple via le demarrage automatique) ?
curl -s -m 2 http://127.0.0.1:3000/api/health 2>nul | find "ok" >nul
if %errorlevel%==0 (
  echo La caisse tourne deja sur ce PC : rien a faire.
  echo Pour l'arreter : desinstaller-demarrage-auto.bat
  pause
  exit /b
)

if not exist client\dist (
  echo Premiere installation, compilation de l'application...
  call npm install
  call npm run build
)
echo Demarrage de la caisse... (fermer cette fenetre arrete la caisse)
npm start -w server
pause
