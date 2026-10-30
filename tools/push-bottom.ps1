param([string]$Hwnd)
# Insert DeskNest window right above the desktop shell window.
# Uses GetShellWindow() which is more reliable than FindWindow("Progman") on Win11.
# SetWindowPos with hWndInsertAfter=shell_hwnd, NOMOVE|NOSIZE|NOACTIVATE.
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class ZB5 {
  [DllImport("user32.dll")] public static extern IntPtr GetShellWindow();
  [DllImport("user32.dll", SetLastError=true)]
  public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
}
"@
$h = [IntPtr][long]$Hwnd
$shell = [ZB5]::GetShellWindow()
$flags = 0x0003 -bor 0x0010    # SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE
$ok = $false
if ($shell -ne [IntPtr]::Zero) {
  $ok = [ZB5]::SetWindowPos($h, $shell, 0, 0, 0, 0, $flags)
}
Write-Output ("shell=" + $(if ($shell -ne [IntPtr]::Zero) { 1 } else { 0 }) + " ok=" + $(if ($ok) { 1 } else { 0 }))