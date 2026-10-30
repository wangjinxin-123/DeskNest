# DeskNest wallpaper scanner (Wallpaper Engine library)
# Locates every local Steam library, walks the Wallpaper Engine workshop items
# (appid 431960) plus the user / built-in projects, and emits one record per
# wallpaper. The still image is what the card uses as its backdrop; "video" is
# the mp4/webm of a video wallpaper (kept for reference, not played by default).
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\scan-wallpapers.ps1 -OutFile out.json
#   out.json: [{"id":"1289832516","title":"...","type":"video","dir":"...","image":"...\\preview.gif","video":"...\\x.mp4"}]
# NOTE: ASCII-only on purpose (Windows PowerShell 5.1 reads .ps1 as ANSI without BOM).
param(
  [Parameter(Mandatory = $true)][string]$OutFile
)

$ErrorActionPreference = 'Continue'
$WE_APPID = '431960'
$IMG_EXT = @('.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp')
$VID_EXT = @('.mp4', '.webm', '.mkv', '.avi', '.mov')

function Get-SteamRoots {
  $roots = New-Object System.Collections.ArrayList
  foreach ($k in @('HKCU:\Software\Valve\Steam', 'HKLM:\SOFTWARE\WOW6432Node\Valve\Steam', 'HKLM:\SOFTWARE\Valve\Steam')) {
    try {
      $p = Get-ItemProperty -Path $k -ErrorAction Stop
      $v = $p.SteamPath
      if (-not $v) { $v = $p.InstallPath }
      if ($v) { [void]$roots.Add(($v -replace '/', '\')) }
    } catch { }
  }
  # Every library folder listed in libraryfolders.vdf (games often live on other drives)
  $extra = New-Object System.Collections.ArrayList
  foreach ($r in @($roots)) {
    $vdf = Join-Path $r 'steamapps\libraryfolders.vdf'
    if (Test-Path -LiteralPath $vdf) {
      $txt = Get-Content -LiteralPath $vdf -Raw -Encoding UTF8
      foreach ($m in [regex]::Matches($txt, '"path"\s*"([^"]+)"')) {
        [void]$extra.Add(($m.Groups[1].Value -replace '\\\\', '\' -replace '/', '\'))
      }
    }
  }
  foreach ($e in $extra) { [void]$roots.Add($e) }
  return @($roots | Select-Object -Unique)
}

$list = New-Object System.Collections.ArrayList
$seen = @{}

# Wallpaper Engine writes one config entry (keyed by the wallpaper file path) for every
# wallpaper the user has actually loaded. The local workshop folder can hold far more
# subscriptions than the user's own library (shared libraries, old bulk subscriptions),
# so this set is what we treat as "my wallpapers".
$usedIds = @{}
foreach ($root in (Get-SteamRoots)) {
  $cfg = Join-Path $root 'steamapps\common\wallpaper_engine\config.json'
  if (Test-Path -LiteralPath $cfg) {
    try {
      $txt = Get-Content -LiteralPath $cfg -Raw -Encoding UTF8
      foreach ($m in [regex]::Matches($txt, '431960[\\/](\d+)')) { $usedIds[$m.Groups[1].Value] = $true }
    } catch { }
  }
}

function Add-Wallpaper([string]$dir, [string]$id) {
  if (-not (Test-Path -LiteralPath $dir)) { return }
  $key = $dir.ToLower()
  if ($seen.ContainsKey($key)) { return }
  $seen[$key] = $true

  $proj = $null
  $pj = Join-Path $dir 'project.json'
  if (Test-Path -LiteralPath $pj) {
    try { $proj = Get-Content -LiteralPath $pj -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $proj = $null }
  }

  $title = ''
  $type = ''
  $mainFile = ''
  $preview = ''
  if ($proj -ne $null) {
    $title = [string]$proj.title
    $type = [string]$proj.type
    $mainFile = [string]$proj.file
    $preview = [string]$proj.preview
  }
  if ([string]::IsNullOrWhiteSpace($title)) { $title = [System.IO.Path]::GetFileName($dir) }

  # Still image for the card backdrop: WE downloads preview.jpg / preview.png /
  # preview.gif next to the project, that one is small and always present.
  $image = ''
  foreach ($name in @('preview.jpg', 'preview.png', 'preview.gif')) {
    $full = Join-Path $dir $name
    if (Test-Path -LiteralPath $full) { $image = $full; break }
  }
  if (-not $image -and $preview) {
    $full = Join-Path $dir $preview
    if (Test-Path -LiteralPath $full) { $image = $full }
  }
  if (-not $image -and $mainFile) {
    $full = Join-Path $dir $mainFile
    if ((Test-Path -LiteralPath $full) -and ($IMG_EXT -contains ([System.IO.Path]::GetExtension($full).ToLower()))) {
      $image = $full
    }
  }
  if (-not $image) { return }

  $video = ''
  if ($mainFile) {
    $full = Join-Path $dir $mainFile
    if ((Test-Path -LiteralPath $full) -and ($VID_EXT -contains ([System.IO.Path]::GetExtension($full).ToLower()))) {
      $video = $full
    }
  }

  [void]$list.Add([ordered]@{
    id    = $id
    title = $title
    type  = $type
    dir   = $dir
    image = $image
    video = $video
    used  = (($id -eq '') -or $usedIds.ContainsKey($id))
  })
}

foreach ($root in (Get-SteamRoots)) {
  # Workshop wallpapers (one folder per subscribed item)
  $ws = Join-Path $root ('steamapps\workshop\content\' + $WE_APPID)
  if (Test-Path -LiteralPath $ws) {
    foreach ($d in (Get-ChildItem -LiteralPath $ws -Directory -ErrorAction SilentlyContinue)) {
      Add-Wallpaper $d.FullName $d.Name
    }
  }
  # Local + built-in projects: projects\<collection>\<project>
  # defaultprojects / templates are shipped with Wallpaper Engine itself - they were never
  # downloaded by the user, so they must not show up as "my wallpapers".
  $pr = Join-Path $root 'steamapps\common\wallpaper_engine\projects'
  if (Test-Path -LiteralPath $pr) {
    foreach ($c in (Get-ChildItem -LiteralPath $pr -Directory -ErrorAction SilentlyContinue)) {
      if ($c.Name -eq 'defaultprojects' -or $c.Name -eq 'templates') { continue }
      foreach ($d in (Get-ChildItem -LiteralPath $c.FullName -Directory -ErrorAction SilentlyContinue)) {
        Add-Wallpaper $d.FullName ''
      }
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
Write-Output ('OK ' + $arr.Count + ' wallpapers')
