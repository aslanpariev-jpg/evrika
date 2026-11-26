$ErrorActionPreference='Stop'
Stop-ScheduledTask -TaskName 'EVRIKA CRM Server' -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName 'EVRIKA CRM Server' -Confirm:$false -ErrorAction SilentlyContinue
Get-NetFirewallRule -DisplayName 'EVRIKA CRM LAN' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
Write-Host 'Autostart and firewall rule removed. Database preserved.'
