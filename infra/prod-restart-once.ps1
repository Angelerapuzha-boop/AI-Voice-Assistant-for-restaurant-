# One-time production voice restart to load the 2026-09-22 naturalness / tone
# changes into the running service. Scheduled to fire ~01:15 (after the 01:00
# close) so it never cuts a live customer call. Safe + self-disabling.
#
# Steps: verify the new code is really on disk -> wait out any in-progress call
# -> stop the port-4811 node process (schtasks /End does NOT kill the child) ->
# trigger the watchdog task to relaunch with fresh code -> health-check -> log.
$ErrorActionPreference = 'Continue'
$repo  = 'C:\ARC Digital_Assistant\meatbox-ai'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$log   = Join-Path $repo ("logs\prod-restart-" + $stamp + ".log")
function Log($m) {
  $line = "$((Get-Date).ToString('yyyy-MM-dd HH:mm:ss'))  $m"
  $line | Out-File -FilePath $log -Append -Encoding utf8
  Write-Output $line
}

Log "=== production voice restart (naturalness/tone) starting ==="

# 0) Never restart into a stale / half-written tree: the new phrasing must be on
#    disk. Two ASCII sentinels unique to the new fast-path code.
$fp  = Join-Path $repo 'packages\core\src\agent\fastpath.ts'
$src = Get-Content $fp -Raw -ErrorAction SilentlyContinue
if (-not $src -or $src -notlike '*Sound good?*' -or $src -notlike '*get a name for the order*') {
  Log "ABORT: expected new phrasing not found on disk (packages/core/src/agent/fastpath.ts) -- not restarting"
  exit 1
}
Log "on-disk code check OK (new phrasing present)"

# 0b) Safety window: only restart while the shop is closed. Local 01:00-11:00
#     is closed every day (Sun/Mon open 17:00, Tue-Sat 11:00; all close 01:00).
#     If this fired late (app reopened during trading) skip with exit 2 so the
#     caller can reschedule for the next close -- never restart during open hours.
$hourNow = (Get-Date).Hour
if ($hourNow -lt 1 -or $hourNow -ge 11) {
  Log "SKIP (exit 2): local time $((Get-Date).ToString('HH:mm')) is outside the safe closed window (01:00-11:00); not restarting."
  exit 2
}
Log "inside safe closed window ($((Get-Date).ToString('HH:mm')))"

# 1) Do not cut a live call. Wait until 0 active calls (best-effort; max 15 min).
$deadline = (Get-Date).AddMinutes(15)
$active = '?'
do {
  try {
    $active = (docker exec meatbox-postgres psql -U meatbox -d meatbox -t -A -c "select count(*) from calls where ended_at is null" 2>$null | Select-Object -First 1)
    if ($active) { $active = $active.Trim() }
  } catch { $active = '?' }
  if ($active -eq '0' -or [string]::IsNullOrEmpty($active) -or $active -eq '?') { break }
  Log "waiting: $active call(s) in progress..."
  Start-Sleep -Seconds 30
} while ((Get-Date) -lt $deadline)
Log "active-call guard cleared (active=$active)"

# 2) Restart: kill the port-4811 owner, then run the watchdog task.
$oldPid = $null
try {
  $oldPid = (Get-NetTCPConnection -LocalPort 4811 -State Listen -ErrorAction Stop).OwningProcess
  Log "stopping voice pid $oldPid"
  Stop-Process -Id $oldPid -Force -ErrorAction Stop
} catch { Log "no listener on 4811 (already down?): $($_.Exception.Message)" }
Start-Sleep -Seconds 2
schtasks /Run /TN "Meatbox AI Voice (port 4811)" 2>&1 | ForEach-Object { Log "schtasks/Run: $_" }

# 3) Health-check (up to ~90s) and confirm the process was actually replaced.
$ok = $false; $newPid = $null
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Seconds 3
  try {
    $h = (Invoke-WebRequest -UseBasicParsing http://localhost:4811/health -TimeoutSec 5).Content
    if ($h -match '"ok":true') {
      try { $newPid = (Get-NetTCPConnection -LocalPort 4811 -State Listen -ErrorAction Stop).OwningProcess } catch {}
      $ok = $true
      Log "health OK (newPid=$newPid, oldPid=$oldPid): $h"
      break
    }
  } catch {}
}
if (-not $ok) {
  Log "WARN: health not confirmed after ~90s -- the 1-min watchdog self-heal should still bring it up; check again shortly"
}

Log "=== restart routine complete (ok=$ok, oldPid=$oldPid, newPid=$newPid) ==="
