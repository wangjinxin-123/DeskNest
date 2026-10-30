param(
  [Parameter(Mandatory = $true)][string]$Out,
  [int]$W = 96,
  [int]$H = 60,
  [int]$SW = 1920,
  [int]$SH = 1080
)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing
$src = New-Object System.Drawing.Bitmap($SW, $SH)
$g = [System.Drawing.Graphics]::FromImage($src)
$g.CopyFromScreen(0, 0, 0, 0, $src.Size)
$small = New-Object System.Drawing.Bitmap($W, $H)
$g2 = [System.Drawing.Graphics]::FromImage($small)
$g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g2.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g2.DrawImage($src, 0, 0, $W, $H)
$small.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $src.Dispose(); $g2.Dispose(); $small.Dispose()
Write-Output ("ok " + $W + "x" + $H + " from " + $SW + "x" + $SH)