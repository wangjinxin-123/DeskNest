# DeskNest elevated legacy-plugin cleanup (Rainmeter + Winstep Nexus)
# Needs administrator rights. Writes a log + result JSON into %TEMP%.
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\uninstall-legacy.ps1
# ASCII-only on purpose (Windows PowerShell 5.1 reads .ps1 as ANSI without BOM).
$ErrorActionPreference = 'Continue'

$log  = Join-Path $env:TEMP 'desknest-uninstall.log'
$json = Join-Path $env:TEMP 'desknest-uninstall.json'
function L([string]$m) {
  $line = (Get-Date -Format 'HH:mm:ss') + '  ' + $m
  Add-Content -LiteralPath $log -Value $line
  Write-Output $line
}
Set-Content -LiteralPath $log -Value ('=== DeskNest elevated uninstall ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ===')

$RM_DIR = 'C:\Program Files\Rainmeter'
$RM_UN  = Join-Path $RM_DIR 'uninst.exe'
$NX_DIR = 'D:\nexus\Winstep'
$NX_UN  = Join-Path $NX_DIR 'unins000.exe'
$RM_KEY = 'HKLM:\SOFTWARE\WOW6432Node\Rainmeter'
$RM_UK  = 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\Rainmeter'
$NX_KEY = 'HKLM:\SOFTWARE\WOW6432Node\Winstep'
$NX_UK  = 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\Winstep Xtreme_is1'

function Kill-App([string[]]$names) {
  foreach ($n in $names) {
    Get-Process -Name $n -ErrorAction SilentlyContinue | ForEach-Object {
      L ("stop process " + $n + " pid=" + $_.Id)
      Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
    }
  }
}

L '--- step 1: stop running processes'
Kill-App @('Rainmeter', 'Nexus', 'Winstep', 'WorkShelf', 'NextSTART', 'WinstepSplash')
Start-Sleep -Seconds 3

L '--- step 2: Rainmeter uninstaller (/S)'
if (Test-Path -LiteralPath $RM_UN) {
  try {
    $p = Start-Process -FilePath $RM_UN -ArgumentList '/S' -PassThru -ErrorAction Stop
    $p | Wait-Process -Timeout 150 -ErrorAction SilentlyContinue
    L ('rainmeter uninstaller exit=' + $p.ExitCode)
  } catch { L ('rainmeter uninstaller error: ' + $_.Exception.Message) }
} else { L 'rainmeter uninstaller not found (already gone?)' }
Start-Sleep -Seconds 4
if (Test-Path -LiteralPath $RM_DIR) {
  L 'leftover: C:\Program Files\Rainmeter -> removing'
  Remove-Item -LiteralPath $RM_DIR -Recurse -Force -ErrorAction SilentlyContinue
}
foreach ($k in @($RM_KEY, $RM_UK)) {
  if (Test-Path $k) { L ('leftover reg: ' + $k + ' -> removing'); Remove-Item $k -Recurse -Force -ErrorAction SilentlyContinue }
}

L '--- step 3: Winstep Nexus uninstaller (/SILENT)'
if (Test-Path -LiteralPath $NX_UN) {
  try {
    $p2 = Start-Process -FilePath $NX_UN -ArgumentList '/SILENT', '/NORESTART' -PassThru -ErrorAction Stop
    $waited = 0
    # Inno Setup 的卸载器会把自己复制到 temp 再执行，所以等目录消失更可靠
    while ((Test-Path -LiteralPath $NX_DIR) -and $waited -lt 150) { Start-Sleep -Seconds 3; $waited += 3 }
    L ('winstep uninstaller waited=' + $waited + 's, dir_exists=' + (Test-Path -LiteralPath $NX_DIR))
  } catch { L ('winstep uninstaller error: ' + $_.Exception.Message) }
} else { L 'winstep uninstaller not found (already gone?)' }
Start-Sleep -Seconds 2
if (Test-Path -LiteralPath $NX_DIR) {
  L 'leftover: D:\nexus\Winstep -> removing'
  Remove-Item -LiteralPath $NX_DIR -Recurse -Force -ErrorAction SilentlyContinue
}
foreach ($f in @('D:\nexus\NexusSetup.exe', 'D:\nexus\ReadMe.txt')) {
  if (Test-Path -LiteralPath $f) { L ('leftover file: ' + $f + ' -> removing'); Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue }
}
foreach ($k in @($NX_KEY, $NX_UK)) {
  if (Test-Path $k) { L ('leftover reg: ' + $k + ' -> removing'); Remove-Item $k -Recurse -Force -ErrorAction SilentlyContinue }
}

L '--- step 4: verify'
$out = [ordered]@{
  ts                        = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
  rainmeter_dir_gone        = -not (Test-Path -LiteralPath $RM_DIR)
  rainmeter_reg_gone        = -not (Test-Path $RM_KEY)
  rainmeter_uninstallkey_gone = -not (Test-Path $RM_UK)
  winstep_dir_gone          = -not (Test-Path -LiteralPath $NX_DIR)
  winstep_reg_gone          = -not (Test-Path $NX_KEY)
  winstep_uninstallkey_gone = -not (Test-Path $NX_UK)
  nexus_exe_left            = (Test-Path -LiteralPath 'D:\nexus\NexusSetup.exe')
  processes_left            = @(Get-Process -Name Rainmeter, Nexus, Winstep -ErrorAction SilentlyContinue | Select-Object -ExpandProperty ProcessName)
  log                       = $log
}
$txt = $out | ConvertTo-Json -Compress
[System.IO.File]::WriteAllText($json, $txt, (New-Object System.Text.UTF8Encoding($false)))
L ('result: ' + $txt)
L '=== done ==='