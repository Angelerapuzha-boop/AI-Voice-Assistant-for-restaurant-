# Meatbox health monitor — runs every 30 min (scheduled task "Meatbox Health Monitor (30m)").
# Checks production (local) AND the cloud box; SMS-alerts the owner if either is
# DOWN (two tries each, to avoid false alarms on a transient blip). The apps
# self-heal (systemd Restart=always on the box, watchdog task on prod) — this
# does NOT restart anything, it just TELLS the owner so a real outage isn't missed.
# Secrets are read from .env and never logged. Kevin 2026-09-26.
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

$targets = @(
  @{ name = "production (local)"; url = "http://localhost:4811/health" },
  @{ name = "cloud box";          url = "https://voice.example.com/health" }
)
$down = @()
foreach ($t in $targets) { if (-not (Healthy $t.url)) { $down += $t.name } }

if ($down.Count -eq 0) { Log "OK - both healthy"; exit 0 }

$msg = "Meatbox ALERT: health check FAILED for " + ($down -join " and ") + " at $(Get-Date -Format 'HH:mm'). It should self-heal within ~1 min - if this repeats, check it."
Log ("DOWN: " + ($down -join ", ") + " - alerting")
if ($sid -and $tok -and $from -and $to) {
  try {
    $auth = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes(("{0}:{1}" -f $sid, $tok)))
    Invoke-RestMethod -Method Post -Uri ("https://api.twilio.com/2010-04-01/Accounts/{0}/Messages.json" -f $sid) `
      -Headers @{ Authorization = "Basic $auth" } `
      -Body @{ To = $to; From = $from; Body = $msg } -TimeoutSec 20 | Out-Null
    Log "SMS alert sent to owner"
  } catch { Log ("SMS FAILED: " + $_.Exception.Message) }
} else {
  Log "SMS creds missing in .env - cannot alert"
}
exit 1
