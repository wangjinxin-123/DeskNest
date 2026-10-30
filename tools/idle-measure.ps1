# DeskNest idle sampling: process count / memory / CPU while the app sits idle.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File tools\idle-measure.ps1 -Minutes 10 -IntervalSec 15
# NOTE: this file is intentionally ASCII-only so it parses correctly under Windows PowerShell 5.1.
param(
  [int]$Minutes = 10,
  [int]$IntervalSec = 15,
  [string]$ProcessName = 'electron',
  [string]$Out = 'artifacts\idle-samples.csv'
)

$cores = (Get-CimInstance Win32_ComputerSystem).NumberOfLogicalProcessors
$root = Split-Path -Parent $PSScriptRoot
$outPath = Join-Path $root $Out
New-Item -ItemType Directory -Force -Path (Split-Path $outPath) | Out-Null

$rows = @()
$prev = $null
$t0 = Get-Date

Write-Output ("start: minutes=$Minutes interval=${IntervalSec}s logicalCores=$cores")

while (((Get-Date) - $t0).TotalMinutes -lt $Minutes) {
  $procs = Get-Process $ProcessName -ErrorAction SilentlyContinue
  if (-not $procs) {
    Write-Output "process not found, retry..."
    Start-Sleep -Seconds $IntervalSec
    continue
  }

  $now = Get-Date
  $ws = ($procs | Measure-Object WorkingSet64 -Sum).Sum / 1MB
  $cpu = ($procs | Measure-Object CPU -Sum).Sum
  $n = ($procs | Measure-Object).Count
  $priv = 0
  try {
    $priv = ((Get-Counter '\Process(electron*)\Working Set - Private' -ErrorAction SilentlyContinue).CounterSamples |
      Measure-Object CookedValue -Sum).Sum / 1MB
  } catch { $priv = 0 }

  if ($prev) {
    $dt = ($now - $prev.t).TotalSeconds
    $dcpu = $cpu - $prev.cpu
    $pct = [math]::Round((($dcpu / $dt) * 100 / $cores), 3)
    $rows += [pscustomobject]@{
      elapsed_s = [math]::Round((($now - $t0).TotalSeconds))
      procs     = $n
      ws_mb     = [math]::Round($ws, 1)
      priv_mb   = [math]::Round($priv, 1)
      cpu_pct   = $pct
    }
  }
  $prev = @{ t = $now; cpu = $cpu }
  Start-Sleep -Seconds $IntervalSec
}

$rows | Export-Csv -NoTypeInformation -Encoding UTF8 -Path $outPath
$wsArr = @($rows.ws_mb)
$privArr = @($rows.priv_mb)
$cpuArr = @($rows.cpu_pct)
[pscustomobject]@{
  samples      = $rows.Count
  procs        = ($rows | Select-Object -Last 1).procs
  ws_first_mb  = $wsArr[0]
  ws_last_mb   = $wsArr[-1]
  ws_avg_mb    = [math]::Round((($wsArr | Measure-Object -Average).Average), 1)
  ws_max_mb    = ($wsArr | Measure-Object -Maximum).Maximum
  priv_first_mb = $privArr[0]
  priv_last_mb  = $privArr[-1]
  priv_avg_mb   = [math]::Round((($privArr | Measure-Object -Average).Average), 1)
  priv_max_mb   = ($privArr | Measure-Object -Maximum).Maximum
  priv_growth_mb = [math]::Round(($privArr[-1] - $privArr[0]), 1)
  cpu_avg_pct  = [math]::Round((($cpuArr | Measure-Object -Average).Average), 3)
  cpu_max_pct  = ($cpuArr | Measure-Object -Maximum).Maximum
  cpu_last_pct = $cpuArr[-1]
  csv          = $outPath
} | Format-List | Out-String | Write-Output