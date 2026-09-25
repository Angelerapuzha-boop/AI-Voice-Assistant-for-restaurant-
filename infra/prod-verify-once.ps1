# One-time verification that PRODUCTION (localhost:4811) picked up the
# 2026-09-22 naturalness / tone changes after the scheduled ~01:15 restart.
#
# Proof model (no live call needed, and we must NOT disturb routing/testing):
#   - the running voice process must have STARTED after 01:00 today (i.e. it was
#     restarted overnight), AND
#   - the on-disk fast-path code carries the new phrasing (the restart script
#     only relaunches when it does), AND
#   - /health is ok.
# Exit 0 = confirmed on new code. Exit 3 = NOT confirmed (needs a restart).
$ErrorActionPreference = 'Continue'
$repo = 'C:\ARC Digital_Assistant\meatbox-ai'
function Out2($m) { Write-Output $m }

Out2 "=== production naturalness verification $((Get-Date).ToString('yyyy-MM-dd HH:mm:ss')) ==="

# 1) newest restart log (if any) from overnight
$restartLog = Get-ChildItem (Join-Path $repo 'logs') -Filter 'prod-restart-*.log' -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($restartLog) {
  Out2 "latest restart log: $($restartLog.Name)  (written $($restartLog.LastWriteTime))"
  Get-Content $restartLog.FullName -Tail 8 | ForEach-Object { Out2 "  | $_" }
} else {
  Out2 "no prod-restart-*.log found (restart may not have run)"
}

# 2) on-disk code sentinels (the new phrasing)
$fp  = Join-Path $repo 'packages\core\src\agent\fastpath.ts'
$src = Get-Content $fp -Raw -ErrorAction SilentlyContinue
$codeNew = ($src -and $src -like '*Sound good?*' -and $src -like '*get a name for the order*')
Out2 "on-disk new phrasing present : $codeNew"

# 3) running voice process start time + health
$startTime = $null; $curPid = $null; $health = $null
try {
  $curPid = (Get-NetTCPConnection -LocalPort 4811 -State Listen -ErrorAction Stop).OwningProcess
  $startTime = (Get-Process -Id $curPid -ErrorAction Stop).StartTime
} catch { Out2 "4811 not listening: $($_.Exception.Message)" }
try { $health = (Invoke-WebRequest -UseBasicParsing http://localhost:4811/health -TimeoutSec 5).Content } catch { $health = "unreachable" }
Out2 "voice pid=$curPid startTime=$startTime"
Out2 "health=$health"

# 4) verdict
$threshold = [datetime]'2026-09-23 01:00:00'   # the scheduled overnight restart
$restartedOvernight = ($startTime -ne $null -and $startTime -ge $threshold)
$healthy = ($health -match '"ok":true')
Out2 "restarted after $($threshold.ToString('yyyy-MM-dd HH:mm')) : $restartedOvernight"

if ($codeNew -and $restartedOvernight -and $healthy) {
  Out2 "VERDICT: CONFIRMED -- production is running the new naturalness/tone code (pid $curPid started $startTime)."
  exit 0
} else {
  Out2 "VERDICT: NOT CONFIRMED -- codeNew=$codeNew restartedOvernight=$restartedOvernight healthy=$healthy. Production likely still on old code; a closed-hours restart is needed."
  exit 3
}
