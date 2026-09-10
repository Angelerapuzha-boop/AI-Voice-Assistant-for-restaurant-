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

function PortBusy([int]$port) {
    $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    return [bool]$conn
}

switch ($App) {
    'voice' {
        if (PortBusy 4811) { exit 0 }
        Set-Location (Join-Path $repo 'apps\voice')
        & node 'node_modules\tsx\dist\cli.mjs' 'src\server.ts'
    }
    'web' {
        if (PortBusy 4810) { exit 0 }
        Set-Location (Join-Path $repo 'apps\web')
        if (-not (Test-Path '.next\BUILD_ID')) {
            # No production build yet - refuse rather than silently run dev.
            throw 'No production build found. Run: pnpm --filter @meatbox/web build'
        }
        & node 'node_modules\next\dist\bin\next' 'start' '-H' '127.0.0.1' '-p' '4810'
    }
    'tunnel' {
        $existing = Get-CimInstance Win32_Process -Filter "Name = 'cloudflared.exe'" |
            Where-Object { $_.CommandLine -match 'meatbox' }
        if ($existing) { exit 0 }
        & cloudflared tunnel --config (Join-Path $repo 'infra\cloudflared\config.yml') run meatbox-voice
    }
}
