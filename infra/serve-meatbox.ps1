# Meatbox AI service launcher - used by the watchdog scheduled tasks.
# Safe to run any time: exits immediately if the service is already healthy.
# -App voice  -> order/voice service on 127.0.0.1:4811 (production, no file watcher)
# -App web    -> Next.js production server on 127.0.0.1:4810
# -App tunnel -> cloudflared tunnel (meatbox-voice + meatbox hostnames)
param(
    [Parameter(Mandatory = $true)][ValidateSet('voice', 'web', 'tunnel')][string]$App
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $repo 'logs'
New-Item -ItemType Directory -Force $logDir | Out-Null

function PortBusy([int]$port) {
    $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    return [bool]$conn
}

# Keep a log from growing unbounded: roll to .old at ~20 MB.
function RollLog([string]$path) {
    if ((Test-Path $path) -and ((Get-Item $path).Length -gt 20mb)) {
        Move-Item -Force $path ($path + '.old')
    }
}

switch ($App) {
    'voice' {
        if (PortBusy 4811) { exit 0 }
        $log = Join-Path $logDir 'voice.log'
        RollLog $log
        Set-Location (Join-Path $repo 'apps\voice')
        & node 'node_modules\tsx\dist\cli.mjs' 'src\server.ts' *>> $log
    }
    'web' {
        if (PortBusy 4810) { exit 0 }
        Set-Location (Join-Path $repo 'apps\web')
        if (-not (Test-Path '.next\BUILD_ID')) {
            # No production build yet - refuse rather than silently run dev.
            throw 'No production build found. Run: pnpm --filter @meatbox/web build'
        }
        $log = Join-Path $logDir 'web.log'
        RollLog $log
        & node 'node_modules\next\dist\bin\next' 'start' '-H' '127.0.0.1' '-p' '4810' *>> $log
    }
    'tunnel' {
        $existing = Get-CimInstance Win32_Process -Filter "Name = 'cloudflared.exe'" |
            Where-Object { $_.CommandLine -match 'meatbox' }
        if ($existing) { exit 0 }
        # Full cloudflared path — a bare `cloudflared` relies on the task's PATH
        # (which lacks the install dir) and silently failed, causing a Cloudflare
        # 1033 outage (2026-09-16).
        $cf = 'C:\Program Files (x86)\cloudflared\cloudflared.exe'
        if (-not (Test-Path $cf)) {
            $cmd = Get-Command cloudflared.exe -ErrorAction SilentlyContinue
            if ($cmd) { $cf = $cmd.Source }
        }
        $cfg = Join-Path $repo 'infra\cloudflared\config.yml'
        # Spawn DETACHED (Start-Process, not blocking `&`): the connector then
        # survives this reap-prone hidden task session instead of dying with it.
        Start-Process -FilePath $cf -ArgumentList "tunnel --config `"$cfg`" run meatbox-voice" -WindowStyle Hidden
    }
}
