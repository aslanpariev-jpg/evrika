# Run elevated PowerShell. Use a stable directory accessible only to trusted users.
$ErrorActionPreference='Stop'
$root=Split-Path $PSScriptRoot -Parent
$node=(Get-Command node.exe).Source
if (!(Test-Path (Join-Path $root '.env'))) { throw 'Run setup first' }
$action=New-ScheduledTaskAction -Execute $node -Argument ('"'+(Join-Path $root 'server\index.js')+'"') -WorkingDirectory $root
$trigger=New-ScheduledTaskTrigger -AtStartup
$settings=New-ScheduledTaskSettingsSet -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
# Use a dedicated or existing trusted Windows account, not SYSTEM. Password is stored by Windows Task Scheduler.
$cred = Get-Credential -UserName ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -Message 'Windows account (actual password, not PIN) for startup task'
Register-ScheduledTask -TaskName 'EVRIKA CRM Server' -Action $action -Trigger $trigger -Settings $settings -User $cred.UserName -Password ($cred.GetNetworkCredential().Password) -RunLevel Limited -Force | Out-Null
# Only Private network profile and local subnet.
if (!(Get-NetFirewallRule -DisplayName 'EVRIKA CRM LAN' -ErrorAction SilentlyContinue)) { New-NetFirewallRule -DisplayName 'EVRIKA CRM LAN' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 3000 -Profile Private -RemoteAddress LocalSubnet | Out-Null }
Start-ScheduledTask -TaskName 'EVRIKA CRM Server'
Write-Host 'Autostart installed. Check http://localhost:3000/api/health.'
