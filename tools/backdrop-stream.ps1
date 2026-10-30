# 参数走 $args（本机 PowerShell 5.1 对 -File + param 命名参数会误报 AmbiguousParameterSet）
$HwndTxt = [string]$args[0]
$OutW = 160
$OutH = 104

# 常驻抓屏小工具：stdin 收 "grab x y w h"（物理像素），stdout 回一行 base64 JPEG。
# 常驻是为了免掉每次 spawn PowerShell 的 300~600ms 冷启动，单帧抓取+编码只要 20~30ms，
# 这样主进程才敢把刷新压到 100ms 一帧。
#
# 抓屏前临时给本窗口设 SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE = 0x11)：
# 窗口一旦 show()，CopyFromScreen 会把卡片自己那层白膜也拍进去，玻璃映玻璃会越糊越白。
# 0x11 让窗口对"抓屏"隐形（人眼照样看得见，完全不闪），抓完立刻复位成 0，
# 保证用户自己用截图工具时卡片还在画面里。

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class NestAffinity {
  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool SetWindowDisplayAffinity(IntPtr hwnd, uint dwAffinity);
}
'@

# JPEG 编码器参数（质量 62）：200×130 的模糊小图用 PNG 要 8~11KB、JPEG 只要 3~4KB，
# 编码也快一倍 —— 这个是能上高帧率的关键。
$jpgCodec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$encParams = New-Object System.Drawing.Imaging.EncoderParameters(1)
$encParams.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [Int64]62)

$hwnd = [IntPtr]([Int64]$HwndTxt)
$stdin = [Console]::In
$stdout = [Console]::Out

while ($true) {
  $line = $stdin.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if ($line.Length -eq 0) { continue }
  if ($line -eq 'quit') { break }

  $p = $line.Split(' ')
  if ($p.Count -lt 5) { continue }
  $x = [int]$p[1]; $y = [int]$p[2]; $w = [int]$p[3]; $h = [int]$p[4]
  if ($w -lt 8 -or $h -lt 8) { continue }

  $bmp = $null; $small = $null; $g = $null; $g2 = $null; $ms = $null
  try {
    [NestAffinity]::SetWindowDisplayAffinity($hwnd, 0x11) | Out-Null
    # 让 DWM 至少重合成一帧，0x11 才会在抓屏面里生效
    Start-Sleep -Milliseconds 0

    $bmp = New-Object System.Drawing.Bitmap($w, $h)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($x, $y, 0, 0, (New-Object System.Drawing.Size($w, $h)))

    $small = New-Object System.Drawing.Bitmap($OutW, $OutH)
    $g2 = [System.Drawing.Graphics]::FromImage($small)
    $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g2.DrawImage($bmp, 0, 0, $OutW, $OutH)

    $ms = New-Object System.IO.MemoryStream
    $small.Save($ms, $jpgCodec, $encParams)

    [NestAffinity]::SetWindowDisplayAffinity($hwnd, 0) | Out-Null
    $stdout.WriteLine([Convert]::ToBase64String($ms.ToArray()))
  } catch {
    try { [NestAffinity]::SetWindowDisplayAffinity($hwnd, 0) | Out-Null } catch { }
    $stdout.WriteLine('ERR')
  } finally {
    $stdout.Flush()
    if ($g) { $g.Dispose() }
    if ($g2) { $g2.Dispose() }
    if ($bmp) { $bmp.Dispose() }
    if ($small) { $small.Dispose() }
    if ($ms) { $ms.Dispose() }
  }
}

