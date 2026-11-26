# Run from PowerShell in the extracted project. PostgreSQL must already be installed.
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
function Assert-Exit { if ($LASTEXITCODE -ne 0) { throw "Command failed: $LASTEXITCODE" } }
$psql = Get-Command psql.exe -ErrorAction SilentlyContinue
if ($psql) { $pgBin = Split-Path $psql.Source -Parent } else {
    $candidate = Get-ChildItem 'C:\Program Files\PostgreSQL\*\bin\psql.exe' -ErrorAction SilentlyContinue | Sort-Object FullName -Descending | Select-Object -First 1
    if (!$candidate) { throw 'PostgreSQL not found. Install PostgreSQL for Windows first (include Command Line Tools).' }
    $pgBin = $candidate.DirectoryName
}
$pgPort = Read-Host 'PostgreSQL port [5432]'; if (!$pgPort) { $pgPort='5432' }
if ($pgPort -notmatch '^\d{1,5}$' -or [int]$pgPort -lt 1 -or [int]$pgPort -gt 65535) { throw 'Invalid port' }
if (!(Test-Path .env)) {
    $dbPassword = & node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"; Assert-Exit
    $jwt = & node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"; Assert-Exit
    $env:PGPASSWORD = [System.Net.NetworkCredential]::new('',(Read-Host 'Password of PostgreSQL superuser postgres' -AsSecureString)).Password
    try {
        $exists = & "$pgBin\psql.exe" -X -w -h 127.0.0.1 -p $pgPort -U postgres -d postgres -tAc "SELECT 1 FROM pg_roles WHERE rolname='evrika_app'"; Assert-Exit
        $dbExists = & "$pgBin\psql.exe" -X -w -h 127.0.0.1 -p $pgPort -U postgres -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='evrika_crm'"; Assert-Exit
        if (($exists -join '').Trim() -eq '1' -or ($dbExists -join '').Trim() -eq '1') { throw 'Database or role already exists. Configure .env manually; no existing data was modified.' }
        & "$pgBin\psql.exe" -X -w -h 127.0.0.1 -p $pgPort -U postgres -d postgres -v ON_ERROR_STOP=1 -c "CREATE ROLE evrika_app LOGIN PASSWORD '$dbPassword'"; Assert-Exit
        & "$pgBin\psql.exe" -X -w -h 127.0.0.1 -p $pgPort -U postgres -d postgres -v ON_ERROR_STOP=1 -c 'CREATE DATABASE evrika_crm OWNER evrika_app ENCODING ''UTF8'''; Assert-Exit
    } finally { Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue }
    @("HOST=0.0.0.0","PORT=3000","DB_HOST=127.0.0.1","DB_PORT=$pgPort","DB_NAME=evrika_crm","DB_USER=evrika_app","DB_PASSWORD=$dbPassword","JWT_SECRET=$jwt","BACKUP_RETENTION_DAYS=30","PG_BIN=$pgBin") | Set-Content -Encoding ASCII .env
    # Limit access to local account, SYSTEM and local Administrators.
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    & icacls.exe .env /inheritance:r /grant:r "${identity}:(F)" '*S-1-5-18:(F)' '*S-1-5-32-544:(F)' | Out-Null
} else { Write-Host '.env already exists. Preserving settings and database.' }
& npm.cmd install; Assert-Exit
$env:INIT_ADMIN_LOGIN = Read-Host 'CRM administrator login [admin]'; if (!$env:INIT_ADMIN_LOGIN) { $env:INIT_ADMIN_LOGIN='admin' }
$env:INIT_ADMIN_PASSWORD = [System.Net.NetworkCredential]::new('',(Read-Host 'New CRM administrator password (12+ characters; ignored if already exists)' -AsSecureString)).Password
try { & npm.cmd run setup; Assert-Exit } finally { Remove-Item Env:INIT_ADMIN_PASSWORD -ErrorAction SilentlyContinue; Remove-Item Env:INIT_ADMIN_LOGIN -ErrorAction SilentlyContinue }
Write-Host 'Setup complete. Run npm.cmd start, then open http://localhost:3000.'
