# Meatbox health WATCHDOG — runs every 30 min (scheduled task "Meatbox Health Monitor (30m)").
# Checks production (local) AND the cloud box. If either is UNHEALTHY it now
# AUTO-REPAIRS (restarts), re-verifies, and SMS-alerts the owner with the outcome
# (auto-repaired / still down) — no manual command needed. Fast crash recovery is
# also covered separately: the 1-min port watchdog on prod and systemd
# Restart=always on the box. Secrets are read from .env and never logged.
$ErrorActionPreference = "Continue"
$repo = "C:\ARC Digital_Assistant\meatbox-ai"
$logDir = Join-Path $repo "logs"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Force $logDir | Out-Null }
$log = Join-Path $logDir "health-monitor.log"
function Log($m) { "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $m" | Out-File -FilePath $log -Append -Encoding utf8 }

# --- read Twilio creds from .env (never logged) ---
$envText = Get-Content (Join-Path $repo ".env") -Raw
function EnvVal($k) {
  $pat = '(?m)^' + [Regex]::Escape($k) + '=(.+)$'
  if ($envText -match $pat) { return $Matches[1].Trim() }
  return ""
}
$sid  = EnvVal "TWILIO_ACCOUNT_SID"
$tok  = EnvVal "TWILIO_AUTH_TOKEN"
$from = EnvVal "TWILIO_PHONE_NUMBER"
$to   = EnvVal "OWNER_NOTIFICATION_PHONE"

function Healthy($url) {
  for ($i = 0; $i -lt 2; $i++) {
    try {
      $r = Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 10
      $j = $r.Content | ConvertFrom-Json
      if ($j.ok -eq $true) { return $true }
    } catch { }
    Start-Sleep -Seconds 3
  }
  return $false
}

function RestartProd {
  Log "repairing production: killing port 4811 listener + running watchdog task"
  try {
    $pids = (Get-NetTCPConnection -LocalPort 4811 -State Listen -ErrorAction SilentlyContinue).OwningProcess | Select-Object -Unique
    foreach ($p in $pids) { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 2
    schtasks /Run /TN "Meatbox AI Voice (port 4811)" | Out-Null
  } catch { Log ("prod restart error: " + $_.Exception.Message) }
}

function RestartBox {
  $pem = "C:\path\to\deploy-key.pem"
  if (-not (Test-Path $pem)) { Log "box key missing - relying on box systemd self-heal"; return }
  Log "repairing box: ssh systemctl restart meatbox-voice"
  try {
    & ssh -i $pem -o StrictHostKeyChecking=no -o UserKnownHostsFile=NUL -o ConnectTimeout=15 ec2-user@203.0.113.10 "sudo systemctl restart meatbox-voice" 2>$null | Out-Null
  } catch { Log ("box restart error: " + $_.Exception.Message) }
}

$targets = @(
  @{ name = "production (local)"; url = "http://localhost:4811/health"; repair = ${function:RestartProd} },
  @{ name = "cloud box";         url = "https://voice.example.com/health"; repair = ${function:RestartBox} }
)

$results = @()
foreach ($t in $targets) {
  if (Healthy $t.url) { continue }
  Log ("UNHEALTHY: " + $t.name + " - auto-repairing")
  & $t.repair
  Start-Sleep -Seconds 20   # give it time to come back up
  if (Healthy $t.url) {
    $results += ($t.name + " was down, AUTO-REPAIRED OK")
    Log ($t.name + " repaired OK")
  } else {
    $results += ($t.name + " DOWN - repair did NOT bring it back")
    Log ($t.name + " STILL DOWN after repair")
  }
}

if ($results.Count -eq 0) { Log "OK - both healthy"; exit 0 }

$msg = "Meatbox watchdog: " + ($results -join "; ") + " at $(Get-Date -Format 'HH:mm')."
if ($sid -and $tok -and $from -and $to) {
  try {
    $auth = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes(("{0}:{1}" -f $sid, $tok)))
    Invoke-RestMethod -Method Post -Uri ("https://api.twilio.com/2010-04-01/Accounts/{0}/Messages.json" -f $sid) `
      -Headers @{ Authorization = "Basic $auth" } `
      -Body @{ To = $to; From = $from; Body = $msg } -TimeoutSec 20 | Out-Null
    Log "SMS sent to owner: $msg"
  } catch { Log ("SMS FAILED: " + $_.Exception.Message) }
} else {
  Log "SMS creds missing in .env - cannot alert"
}
exit 1
