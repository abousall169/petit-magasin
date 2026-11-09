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
rem --- Le certificat HTTPS couvre toujours le point d'acces mobile Windows, meme s'il est active apres la caisse.
set "TLS_NAMES=192.168.137.1,%TLS_NAMES%"
echo Demarrage de la caisse... (fermer cette fenetre arrete la caisse)
npm start -w server
pause
