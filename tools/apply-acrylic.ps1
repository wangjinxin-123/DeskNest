param([string]$Hwnd)
# Try both acrylic APIs; success = accent=0 or dwm=0.
# Skips DwmSetWindowAttribute(33) -- that paints the white rounded frame.
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class NSG3 {
  [StructLayout(LayoutKind.Sequential)]
  public struct AccentPolicy {
    public int AccentState; public int AccentFlags; public int GradientColor; public int AnimationId;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct WinCompAttrData {
    public int Attribute; public IntPtr Data; public int SizeOfData;
  }
  [DllImport("user32.dll")]
  public static extern int SetWindowCompositionAttribute(IntPtr hwnd, ref WinCompAttrData data);
  [DllImport("dwmapi.dll")]
  public static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);

  public static string Try(IntPtr hwnd) {
    // 1) SetWindowCompositionAttribute (older API)
    int accentR = -1;
    try {
      AccentPolicy ap = new AccentPolicy();
      ap.AccentState = 4; ap.AccentFlags = 2;  // ACCENT_ENABLE_ACRYLICBLURBEHIND
      ap.GradientColor = unchecked((int)0xB3F2F6FF); ap.AnimationId = 0;
      int sz = Marshal.SizeOf(ap);
      IntPtr ptr = Marshal.AllocHGlobal(sz);
      Marshal.StructureToPtr(ap, ptr, false);
      WinCompAttrData data = new WinCompAttrData();
      data.Attribute = 19; data.Data = ptr; data.SizeOfData = sz;
      accentR = SetWindowCompositionAttribute(hwnd, ref data);
      Marshal.FreeHGlobal(ptr);
    } catch { accentR = -2; }

    // 2) DwmSetWindowAttribute(38,3)=Acrylic + DwmSetWindowAttribute(34,0)=transparent border
    int dwmR = -1, borderR = -1;
    try {
      int backdrop = 3;
      dwmR = DwmSetWindowAttribute(hwnd, 38, ref backdrop, 4);
      int transparent = 0; // DWMWA_BORDER_COLOR
      borderR = DwmSetWindowAttribute(hwnd, 34, ref transparent, 4);
    } catch { dwmR = -2; }

    return "accent=" + accentR + " dwm=" + dwmR + " border=" + borderR;
  }
}
"@
$h = [IntPtr][int64]$Hwnd
$r = [NSG3]::Try($h)
Write-Output $r