# DeskNest installed-app scanner
# Walks both Start Menu "Programs" folders, resolves every .lnk to its real target
# and emits the shortcuts that actually launch an application (desktop apps + UWP).
# Filtering / de-duplication / sorting happens in the main process (JS handles
# Chinese names safely; this file must stay ASCII-only so PowerShell 5.1 reads it).
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\scan-apps.ps1 -OutFile out.json
#   out.json: [{"path":"...\\Chrome.lnk","name":"Chrome","target":"...\\chrome.exe","args":"","icon":"...\\chrome.exe","uwp":false}]
# NOTE: ASCII-only on purpose (Windows PowerShell 5.1 reads .ps1 as ANSI without BOM).
param(
  [Parameter(Mandatory = $true)][string]$OutFile
)

$ErrorActionPreference = 'Continue'

$roots = @(
  (Join-Path -Path $env:APPDATA -ChildPath 'Microsoft\Windows\Start Menu\Programs'),
  (Join-Path -Path $env:ProgramData -ChildPath 'Microsoft\Windows\Start Menu\Programs')
)

try { $shell = New-Object -ComObject WScript.Shell } catch { $shell = $null }
$list = New-Object System.Collections.ArrayList
$seen = @{}

if ($shell -ne $null) {
  foreach ($root in $roots) {
    if (-not (Test-Path -LiteralPath $root)) { continue }
    $files = Get-ChildItem -LiteralPath $root -Recurse -Filter *.lnk -File -ErrorAction SilentlyContinue
    foreach ($f in $files) {
      try {
        $lnk = $shell.CreateShortcut($f.FullName)
        $target = [string]$lnk.TargetPath
        $args = [string]$lnk.Arguments
        if ([string]::IsNullOrWhiteSpace($target)) { continue }
        $target = [Environment]::ExpandEnvironmentVariables($target)
        $ext = [System.IO.Path]::GetExtension($target).ToLower()
        if (@('.exe', '.com', '.bat', '.cmd') -notcontains $ext) { continue }

        $leaf = [System.IO.Path]::GetFileName($target).ToLower()
        # UWP / Store apps: the shortcut points at explorer.exe with shell:AppsFolder\...
        $uwp = ($leaf -eq 'explorer.exe' -and $args -match '(?i)shell:AppsFolder')
        if (-not $uwp -and -not (Test-Path -LiteralPath $target)) { continue }

        # De-duplicate here by the thing that actually gets launched (UWP shares explorer.exe)
        $key = $target.ToLower()
        if ($uwp) { $key = 'uwp|' + $args.ToLower() }
        if ($seen.ContainsKey($key)) { continue }
        $seen[$key] = $true

        # What the shell should read the icon from. UWP shortcuts have no icon location,
        # so the .lnk itself is handed over and the extractor asks the shell for its icon.
        $icon = ''
        $iconLoc = [string]$lnk.IconLocation
        if ($iconLoc) {
          $iconFile = ($iconLoc -split ',')[0].Trim().Trim('"')
          $iconFile = [Environment]::ExpandEnvironmentVariables($iconFile)
          if ($iconFile -and (Test-Path -LiteralPath $iconFile)) { $icon = $iconFile }
        }
        if (-not $icon) { if ($uwp) { $icon = $f.FullName } else { $icon = $target } }

        [void]$list.Add([ordered]@{
          path   = $f.FullName
          name   = [System.IO.Path]::GetFileNameWithoutExtension($f.Name)
          target = $target
          args   = $args
          icon   = $icon
          uwp    = [bool]$uwp
        })
      } catch { }
    }
  }
}

# ConvertTo-Json unwraps single-element arrays, so serialize via -InputObject and a forced array
$arr = @($list)
if ($arr.Count -eq 0) {
  $json = '[]'
} else {
  $json = ConvertTo-Json -InputObject $arr -Depth 4
  if (-not $json.TrimStart().StartsWith('[')) { $json = '[' + $json + ']' }
}
$dir = [System.IO.Path]::GetDirectoryName($OutFile)
if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
[System.IO.File]::WriteAllText($OutFile, $json, (New-Object System.Text.UTF8Encoding($false)))
Write-Output ('OK ' + $arr.Count + ' shortcuts')
