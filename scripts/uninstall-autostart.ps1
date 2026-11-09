# Retire le démarrage automatique de la caisse (tâche planifiée + règle de pare-feu) et arrête le serveur lancé par la tâche.
param([string]$TaskName = 'CaisseMagasin')
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

# Arrête toute instance de la caisse de CE dossier (script de relance + serveur node), même orpheline.
function Stop-CaisseProcesses {
  $all = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue
  $mine = @($all | Where-Object { $_.CommandLine -and $_.ProcessId -ne $PID -and (
      ($_.Name -eq 'powershell.exe' -and $_.CommandLine -like "*$root\scripts\serveur.ps1*") -or
      ($_.Name -eq 'node.exe' -and $_.CommandLine -like "*$root\server\src\index.js*")) })
  # d'abord les scripts de relance (sinon ils relanceraient le serveur), puis les serveurs
  foreach ($p in ($mine | Sort-Object { $_.Name -ne 'powershell.exe' })) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
  if ($mine.Count) { Start-Sleep -Seconds 1 }
}

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "Tâche « $TaskName » supprimée."
} else { Write-Host "Aucune tâche « $TaskName »." }

Stop-CaisseProcesses

$ruleName = if ($TaskName -eq 'CaisseMagasin') { 'Caisse Magasin (réseau local)' } else { "Caisse Magasin ($TaskName)" }
$rule = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
if ($rule) {
  if ($isAdmin) { $rule | Remove-NetFirewallRule; Write-Host 'Règle de pare-feu supprimée.' }
  else { Write-Warning 'Règle de pare-feu conservée (droits administrateur requis pour la supprimer).' }
}
Write-Host 'Terminé. Vos données (dossier data) sont conservées.'
