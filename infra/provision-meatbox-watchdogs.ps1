# Provision / repair the Meatbox AI watchdog scheduled tasks (voice, web, tunnel).
# Safe to re-run any time. Same pattern as provision-arc-watchdogs.ps1:
# logon trigger + 5-minute self-heal, wrapped in conhost.exe --headless so
# Windows Terminal cannot reap the hidden console (the 2026-07-13 lesson).
$ErrorActionPreference = 'Stop'

$repo  = Split-Path -Parent $PSScriptRoot
$sid   = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$user  = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$start = (Get-Date).AddMinutes(2).ToString('yyyy-MM-ddTHH:mm:ss')

$apps = @(
    @{ Name = 'Meatbox AI Voice (port 4811)';  App = 'voice'  },
    @{ Name = 'Meatbox AI Web (port 4810)';    App = 'web'    },
    @{ Name = 'Meatbox AI Tunnel';             App = 'tunnel' }
)

$template = @'
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.3" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <URI>\{NAME}</URI>
  </RegistrationInfo>
  <Principals>
    <Principal id="Author">
      <UserId>{SID}</UserId>
      <LogonType>InteractiveToken</LogonType>
    </Principal>
  </Principals>
  <Settings>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <RestartOnFailure>
      <Count>3</Count>
      <Interval>PT1M</Interval>
    </RestartOnFailure>
    <UseUnifiedSchedulingEngine>true</UseUnifiedSchedulingEngine>
  </Settings>
  <Triggers>
    <LogonTrigger>
      <UserId>{USER}</UserId>
    </LogonTrigger>
    <TimeTrigger>
      <StartBoundary>{START}</StartBoundary>
      <Repetition>
        <Interval>PT5M</Interval>
      </Repetition>
    </TimeTrigger>
  </Triggers>
  <Actions Context="Author">
    <Exec>
      <Command>C:\WINDOWS\system32\conhost.exe</Command>
      <Arguments>--headless powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{REPO}\infra\serve-meatbox.ps1" -App {APP}</Arguments>
    </Exec>
  </Actions>
</Task>
'@

foreach ($app in $apps) {
    $xml = $template.
        Replace('{NAME}', $app.Name).
        Replace('{SID}', $sid).
        Replace('{USER}', $user).
        Replace('{START}', $start).
        Replace('{REPO}', $repo).
        Replace('{APP}', $app.App)
    $tmp = Join-Path $env:TEMP ("meatbox-task-" + $app.App + ".xml")
    $xml | Out-File -FilePath $tmp -Encoding Unicode
    schtasks /Create /TN $app.Name /XML $tmp /F | Out-Null
    Remove-Item $tmp
    Write-Host "registered: $($app.Name)"
}

foreach ($app in $apps) {
    schtasks /Run /TN $app.Name | Out-Null
    Write-Host "started: $($app.Name)"
}
Write-Host 'Done. Services self-heal every 5 minutes and start on logon.'
