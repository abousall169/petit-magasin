# Lance le serveur de la caisse et le relance automatiquement s'il s'arrête (plantage, erreur…).
# Utilisé par la tâche planifiée « CaisseMagasin » ; peut aussi être lancé à la main.
param([string]$NodePath, [string]$DataDir, [int]$Port, [int]$HttpsPort)

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
if ($DataDir)   { $env:DATA_DIR = $DataDir }
if ($Port)      { $env:PORT = "$Port" }
if ($HttpsPort) { $env:HTTPS_PORT = "$HttpsPort" }

if (-not $NodePath) { $NodePath = (Get-Command node -ErrorAction SilentlyContinue).Source }
if (-not $NodePath) { $NodePath = Join-Path $env:ProgramFiles 'nodejs\node.exe' }

$dataRoot = if ($env:DATA_DIR) { $env:DATA_DIR } else { Join-Path $root 'data' }
$logDir = Join-Path $dataRoot 'logs'
New-Item -ItemType Directory -Force $logDir | Out-Null
$log = Join-Path $logDir 'serveur.log'
$out = Join-Path $logDir 'serveur.sortie.log'
$err = Join-Path $logDir 'serveur.erreurs.log'
function Journal($msg) { "[$(Get-Date -Format 's')] $msg" | Add-Content -Path $log -Encoding UTF8 }

while ($true) {
  if ((Test-Path $log) -and (Get-Item $log).Length -gt 2MB) { Move-Item -Force $log "$log.ancien" }
  foreach ($f in @($out, $err)) { if (Test-Path $f) { Copy-Item -Force $f "$f.precedent" } }
  Journal "Démarrage du serveur (node : $NodePath)"
  $p = Start-Process -FilePath $NodePath -ArgumentList '--disable-warning=ExperimentalWarning', "`"$root\server\src\index.js`"" `
        -WorkingDirectory $root -NoNewWindow -PassThru -Wait -RedirectStandardOutput $out -RedirectStandardError $err
  Journal "Serveur arrêté (code $($p.ExitCode)). Redémarrage dans 5 secondes."
  Start-Sleep -Seconds 5
}
