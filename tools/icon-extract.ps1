# DeskNest icon extractor (Windows Shell image list -> PNG)
# Extracts the REAL system icon of a file / shortcut / folder, preferring the
# 256px "jumbo" shell image list, then falls back to 48px.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\icon-extract.ps1 -InFile in.json -OutFile out.json
#   in.json : [{"src":"C:\\path\\app.lnk","out":"C:\\cache\\abc.png"}]
#   out.json: [{"src":"...","ok":true,"w":256,"h":256,"bytes":12345}]
# NOTE: ASCII-only on purpose (Windows PowerShell 5.1 reads .ps1 as ANSI without BOM).
param(
  [Parameter(Mandatory = $true)][string]$InFile,
  [Parameter(Mandatory = $true)][string]$OutFile
)

$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName System.Drawing

# Read/write both files as explicit UTF-8 (PS 5.1 reads BOM-less files as ANSI and mangles CJK paths)
$jobs = Get-Content -LiteralPath $InFile -Raw -Encoding UTF8 | ConvertFrom-Json

Add-Type -ReferencedAssemblies System.Drawing @"
using System;
using System.Runtime.InteropServices;
using System.Drawing;
using System.Drawing.Imaging;

public class NestIcons {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct SHFILEINFO {
    public IntPtr hIcon; public int iIcon; public uint dwAttributes;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szDisplayName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 80)] public string szTypeName;
  }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  public static extern IntPtr SHGetFileInfo(string p, uint attrs, ref SHFILEINFO fi, uint cb, uint flags);
  [DllImport("shell32.dll")]
  public static extern int SHGetImageList(int iImageList, ref Guid riid, out IImageList ppv);
  [DllImport("user32.dll")] public static extern bool DestroyIcon(IntPtr h);

  [ComImport, Guid("46EB5926-582E-4017-9FDF-E8998DAA0950"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IImageList {
    int Add(IntPtr hbmImage, IntPtr hbmMask, ref int pi);
    int ReplaceIcon(int i, IntPtr hicon, ref int pi);
    int SetOverlayImage(int iImage, int iOverlay);
    int Replace(int i, IntPtr hbmImage, IntPtr hbmMask);
    int AddMasked(IntPtr hbmImage, int crMask, ref int pi);
    int Draw(IntPtr pimldp);
    int Remove(int i);
    int GetIcon(int i, int flags, ref IntPtr picon);
  }

  // shil: 4 = SHIL_JUMBO(256), 2 = SHIL_EXTRALARGE(48)
  public static Bitmap FromImageList(string path, int shil) {
    SHFILEINFO fi = new SHFILEINFO();
    IntPtr ok = SHGetFileInfo(path, 0, ref fi, (uint)Marshal.SizeOf(typeof(SHFILEINFO)), 0x000004000);
    if (ok == IntPtr.Zero) return null;
    Guid iid = new Guid("46EB5926-582E-4017-9FDF-E8998DAA0950");
    IImageList list;
    if (SHGetImageList(shil, ref iid, out list) != 0 || list == null) return null;
    IntPtr h = IntPtr.Zero;
    if (list.GetIcon(fi.iIcon, 1, ref h) != 0 || h == IntPtr.Zero) return null;
    Bitmap bmp = null;
    try {
      Icon ic = Icon.FromHandle(h);
      bmp = ic.ToBitmap();
    } catch { bmp = null; }
    DestroyIcon(h);
    return bmp;
  }

  public static Bitmap Best(string path) {
    Bitmap big = FromImageList(path, 4);
    if (big != null && big.Width >= 64) return big;
    Bitmap mid = FromImageList(path, 2);
    if (mid != null && (big == null || mid.Width > big.Width)) { if (big != null) big.Dispose(); return mid; }
    return big;
  }

  /* Some executables ship no large icon resource: the shell then hands back a 256x256 canvas
     with the small (about 45px) icon painted at the top-left corner. Rendered inside a 42px
     tile that looks like a dot, not an icon. Measure the real content box and crop the empty
     padding away -- only when the glyph clearly does NOT fill the canvas, so ordinary icons
     (which are already 90%+ full) are returned untouched. */
  public static Bitmap Crop(Bitmap src) {
    if (src == null) return null;
    int w = src.Width, h = src.Height;
    if (w < 32 || h < 32) return src;
    Bitmap flat = null;
    BitmapData d = null;
    int minX = w, minY = h, maxX = -1, maxY = -1;
    try {
      flat = new Bitmap(w, h, PixelFormat.Format32bppArgb);
      using (Graphics g = Graphics.FromImage(flat)) { g.DrawImage(src, 0, 0, w, h); }
      d = flat.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
      int stride = Math.Abs(d.Stride);
      byte[] row = new byte[stride];
      for (int y = 0; y < h; y++) {
        Marshal.Copy((IntPtr)(d.Scan0.ToInt64() + (long)y * d.Stride), row, 0, stride);
        for (int x = 0; x < w; x++) {
          if (row[x * 4 + 3] > 24) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
    } catch {
      if (d != null && flat != null) { try { flat.UnlockBits(d); } catch { } }
      if (flat != null) flat.Dispose();
      return src;
    }
    try { flat.UnlockBits(d); } catch { }
    if (maxX < 0) { flat.Dispose(); return src; }                        // fully transparent
    int cw = maxX - minX + 1, ch = maxY - minY + 1;
    if (cw >= w * 0.6 || ch >= h * 0.6) { flat.Dispose(); return src; }  // normal icon, leave as is
    Bitmap outB = new Bitmap(cw, ch, PixelFormat.Format32bppArgb);
    using (Graphics g = Graphics.FromImage(outB)) {
      g.DrawImage(flat, new Rectangle(0, 0, cw, ch), new Rectangle(minX, minY, cw, ch), GraphicsUnit.Pixel);
    }
    flat.Dispose();
    return outB;
  }

  /* Windows 11 ships a lot of shell icons as "white rounded square + logo on top".
     On the card that white plate is a visible frame around the app, which is exactly
     what the user asked to remove.
     Guard: only touch icons whose WHOLE border is light (plate icons). A logo that
     merely contains white art (Notepad's page, a folder) touches the border only
     partly and is left untouched, so its white areas survive.
     Then flood fill inward over transparent / light pixels, crop to what is left and
     pad back to a square. Whites enclosed by colour (Chrome's inner circle, logo text
     on a dark plate) are not reachable from the border, so they survive as well. */
  public static Bitmap StripWhite(Bitmap src) {
    if (src == null) return null;
    int w = src.Width, h = src.Height;
    if (w < 16 || h < 16) return src;
    Bitmap flat = null;
    BitmapData d = null;
    try {
      flat = new Bitmap(w, h, PixelFormat.Format32bppArgb);
      using (Graphics g = Graphics.FromImage(flat)) { g.DrawImage(src, 0, 0, w, h); }
      d = flat.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadWrite, PixelFormat.Format32bppArgb);
      int stride = Math.Abs(d.Stride);
      byte[] px = new byte[stride * h];
      Marshal.Copy(d.Scan0, px, 0, px.Length);

      /* light = neutral and bright; alpha < 40 already counts as background */
      int borderN = 0, borderLight = 0;
      for (int x = 0; x < w; x++) { borderN += 2; borderLight += Edge(px, stride, x, 0, w); borderLight += Edge(px, stride, x, h - 1, w); }
      for (int y = 0; y < h; y++) { borderN += 2; borderLight += Edge(px, stride, 0, y, w); borderLight += Edge(px, stride, w - 1, y, w); }
      if (borderLight * 100 < borderN * 55) { flat.UnlockBits(d); flat.Dispose(); return src; }

      bool[] done = new bool[w * h];
      System.Collections.Generic.Stack<int> st = new System.Collections.Generic.Stack<int>();
      for (int x = 0; x < w; x++) { st.Push(x); st.Push((h - 1) * w + x); }
      for (int y = 0; y < h; y++) { st.Push(y * w); st.Push(y * w + w - 1); }

      bool changed = false;
      while (st.Count > 0) {
        int i = st.Pop();
        if (done[i]) continue;
        done[i] = true;
        int x = i % w, y = i / w;
        int o = y * stride + x * 4;
        if (!IsBg(px, o)) continue;
        if (px[o + 3] >= 40) { px[o] = 0; px[o + 1] = 0; px[o + 2] = 0; px[o + 3] = 0; changed = true; }
        if (x > 0) st.Push(i - 1);
        if (x < w - 1) st.Push(i + 1);
        if (y > 0) st.Push(i - w);
        if (y < h - 1) st.Push(i + w);
      }

      if (!changed) { flat.UnlockBits(d); flat.Dispose(); return src; }
      Marshal.Copy(px, 0, d.Scan0, px.Length);
      flat.UnlockBits(d);

      int minX = w, minY = h, maxX = -1, maxY = -1;
      for (int y = 0; y < h; y++) {
        for (int x = 0; x < w; x++) {
          if (px[y * stride + x * 4 + 3] > 16) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      if (maxX < 0) { flat.Dispose(); return src; }
      int cw = maxX - minX + 1, ch = maxY - minY + 1;
      int side = Math.Max(cw, ch);
      Bitmap outB = new Bitmap(side, side, PixelFormat.Format32bppArgb);
      using (Graphics g = Graphics.FromImage(outB)) {
        g.DrawImage(flat, new Rectangle((side - cw) / 2, (side - ch) / 2, cw, ch),
                          new Rectangle(minX, minY, cw, ch), GraphicsUnit.Pixel);
      }
      flat.Dispose();
      return outB;
    } catch {
      if (d != null && flat != null) { try { flat.UnlockBits(d); } catch { } }
      if (flat != null) flat.Dispose();
      return src;
    }
  }

  /* One border pixel: 1 when it reads as background (transparent or neutral-bright). */
  static int Edge(byte[] px, int stride, int x, int y, int w) {
    int o = y * stride + x * 4;
    if (px[o + 3] < 40) return 1;
    return IsBg(px, o) ? 1 : 0;
  }

  static bool IsBg(byte[] px, int o) {
    int a = px[o + 3];
    if (a < 40) return true;
    int b = px[o], g = px[o + 1], r = px[o + 2];
    if (r >= 232 && g >= 232 && b >= 232) return true;                  // white
    int mx = Math.Max(r, Math.Max(g, b)), mn = Math.Min(r, Math.Min(g, b));
    return mn >= 185 && (mx - mn) <= 18;                                // light neutral grey (plate edge / soft shadow)
  }
}
"@

function Resolve-IconSource {
  param([string]$Path, [string]$Ext)
  # Shortcuts: follow the target / the explicit IconLocation so we show the app's own icon
  if ($Ext -eq '.lnk') {
    try {
      $sh = New-Object -ComObject WScript.Shell
      $lnk = $sh.CreateShortcut($Path)
      $iconLoc = $lnk.IconLocation
      if ($iconLoc) {
        $iconFile = ($iconLoc -split ',')[0].Trim().Trim('"')
        if ($iconFile -and (Test-Path -LiteralPath $iconFile)) { return $iconFile }
      }
      $t = $lnk.TargetPath
      if ($t) {
        $t = [Environment]::ExpandEnvironmentVariables($t)
        if (Test-Path -LiteralPath $t) { return $t }
      }
    } catch { }
    return $Path
  }
  if ($Ext -eq '.url') {
    try {
      $txt = Get-Content -LiteralPath $Path -Raw -ErrorAction Stop
      $m = [regex]::Match($txt, '(?im)^\s*IconFile\s*=\s*(.+?)\s*$')
      if ($m.Success) {
        $f = $m.Groups[1].Value.Trim().Trim('"')
        if ($f -and (Test-Path -LiteralPath $f)) { return $f }
      }
    } catch { }
    return $Path
  }
  return $Path
}

$jobs = Get-Content -LiteralPath $InFile -Raw -Encoding UTF8 | ConvertFrom-Json
$results = New-Object System.Collections.ArrayList

foreach ($j in $jobs) {
  $src = $j.src
  $out = $j.out
  $rec = [ordered]@{ src = $src; ok = $false; w = 0; h = 0; bytes = 0; err = '' }
  try {
    if (-not (Test-Path -LiteralPath $src)) { throw 'missing' }
    $ext = [System.IO.Path]::GetExtension($src).ToLower()
    $iconSrc = Resolve-IconSource -Path $src -Ext $ext
    $bmp = [NestIcons]::Best($iconSrc)
    if ($bmp -eq $null -and $iconSrc -ne $src) { $bmp = [NestIcons]::Best($src) }
    if ($bmp -eq $null) { throw 'no-icon' }
    # Drop the white rounded plate that Windows 11 bakes into some shell icons
    $bmp = [NestIcons]::StripWhite($bmp)
    # Trim the empty padding left by a small icon painted on a big canvas (normal icons unchanged)
    $bmp = [NestIcons]::Crop($bmp)
    if ($bmp -eq $null) { throw 'no-icon' }
    $dir = [System.IO.Path]::GetDirectoryName($out)
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
    $rec.ok = $true; $rec.w = $bmp.Width; $rec.h = $bmp.Height; $rec.bytes = (Get-Item -LiteralPath $out).Length
    $bmp.Dispose()
  } catch {
    $rec.err = $_.Exception.Message
  }
  [void]$results.Add([pscustomobject]$rec)
}

$json = $results | ConvertTo-Json -Compress -Depth 4
[System.IO.File]::WriteAllText($OutFile, $json, (New-Object System.Text.UTF8Encoding($false)))
Write-Output ('OK ' + $results.Count + ' items, ' + ($results | Where-Object { $_.ok }).Count + ' extracted')