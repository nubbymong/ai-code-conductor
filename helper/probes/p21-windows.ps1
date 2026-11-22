# Probe P21's Windows side (p21-capture.cjs runs it; ADR-030, plan 2.1.3-beta.14 C6).
# It prints one JSON line. It reads only, except `scale -Set`, which changes the primary
# display's scale in the session it runs in (nothing here puts it back: whoever runs the
# probe sets the scale found again with a second `console-scale --set`), and the task
# modes, which add, read and remove one scheduled task of this user's.
#   -Mode facts       : the session id, whether LogonUI runs in it, whether this process is
#                       elevated, each attached display's mode (EnumDisplaySettings, physical
#                       pixels) and each display's effective DPI (GetDpiForMonitor, in a thread
#                       aware of each display's scale).
#   -Mode scale [-Set <percent>] : each active display source's scale, the steps it allows and
#                       the recommended one, through the display configuration call the Settings
#                       page makes (the source's DPI scale); with -Set, the primary display's
#                       scale is set first and read again 3 s later.
#   -Mode task-run -Name <n> -Exe <program> -Arguments <text> -Dir <folder> : register and start a
#                       task that runs the program in this user's signed-in session only, not
#                       elevated.
#   -Mode task-info -Name <n> : that task's state and last result (0x00041303: it has not run).
#   -Mode task-remove -Name <n> : stop and remove that task, if it is there.
param(
  [ValidateSet('facts', 'scale', 'task-run', 'task-info', 'task-remove')][string]$Mode = 'facts',
  [int]$Set = 0,
  [string]$Name = '',
  [string]$Exe = '',
  [string]$Arguments = '',
  [string]$Dir = ''
)
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class P21Win {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct DISPLAY_DEVICE {
    public int cb;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string DeviceName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceString;
    public int StateFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceID;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceKey;
  }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct DEVMODE {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName;
    public short dmSpecVersion; public short dmDriverVersion; public short dmSize; public short dmDriverExtra;
    public int dmFields; public int dmPositionX; public int dmPositionY; public int dmDisplayOrientation; public int dmDisplayFixedOutput;
    public short dmColor; public short dmDuplex; public short dmYResolution; public short dmTTOption; public short dmCollate;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName;
    public short dmLogPixels; public int dmBitsPerPel; public int dmPelsWidth; public int dmPelsHeight;
    public int dmDisplayFlags; public int dmDisplayFrequency; public int dmICMMethod; public int dmICMIntent;
    public int dmMediaType; public int dmDitherType; public int dmReserved1; public int dmReserved2;
    public int dmPanningWidth; public int dmPanningHeight;
  }

  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int left; public int top; public int right; public int bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }
  public delegate bool MonitorEnumProc(IntPtr monitor, IntPtr hdc, IntPtr rect, IntPtr data);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool EnumDisplayDevices(string device, uint index, ref DISPLAY_DEVICE dd, uint flags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool EnumDisplaySettings(string device, int mode, ref DEVMODE dm);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorEnumProc proc, IntPtr data);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);
  [DllImport("shcore.dll")] static extern int GetDpiForMonitor(IntPtr monitor, int type, out uint x, out uint y);
  [DllImport("user32.dll")] static extern int GetDisplayConfigBufferSizes(uint flags, out uint paths, out uint modes);
  [DllImport("user32.dll")] static extern int QueryDisplayConfig(uint flags, ref uint paths, [Out] byte[] pathInfo, ref uint modes, [Out] byte[] modeInfo, IntPtr topology);
  [DllImport("user32.dll")] static extern int DisplayConfigGetDeviceInfo([In, Out] byte[] packet);
  [DllImport("user32.dll")] static extern int DisplayConfigSetDeviceInfo([In] byte[] packet);

  // "left,top,width,height,primary,device" for each display attached to the desktop.
  public static List<string> Modes() {
    var list = new List<string>();
    SetThreadDpiAwarenessContext(new IntPtr(-4));
    for (uint i = 0; i < 64; i++) {
      var dd = new DISPLAY_DEVICE();
      dd.cb = Marshal.SizeOf(typeof(DISPLAY_DEVICE));
      if (!EnumDisplayDevices(null, i, ref dd, 0)) break;
      if ((dd.StateFlags & 1) == 0) continue;
      var dm = new DEVMODE();
      dm.dmSize = (short)Marshal.SizeOf(typeof(DEVMODE));
      if (!EnumDisplaySettings(dd.DeviceName, -1, ref dm)) continue;
      list.Add(dm.dmPositionX + "," + dm.dmPositionY + "," + dm.dmPelsWidth + "," + dm.dmPelsHeight + "," + (((dd.StateFlags & 4) != 0) ? 1 : 0) + "," + dd.DeviceName);
    }
    return list;
  }

  // "left,top,width,height,primary,dpi" for each display, read in a thread aware of each display's scale.
  public static List<string> Dpis() {
    var list = new List<string>();
    SetThreadDpiAwarenessContext(new IntPtr(-4));
    MonitorEnumProc proc = (m, h, r, d) => {
      var info = new MONITORINFO();
      info.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
      uint x = 0, y = 0;
      if (GetMonitorInfo(m, ref info) && GetDpiForMonitor(m, 0, out x, out y) == 0) {
        list.Add(info.rcMonitor.left + "," + info.rcMonitor.top + "," + (info.rcMonitor.right - info.rcMonitor.left) + "," + (info.rcMonitor.bottom - info.rcMonitor.top) + "," + (((info.dwFlags & 1) != 0) ? 1 : 0) + "," + x);
      } else {
        list.Add("error");
      }
      return true;
    };
    EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, proc, IntPtr.Zero);
    GC.KeepAlive(proc);
    return list;
  }

  // The scale steps Windows offers, from 100%: a source's recommended step is its index
  // abs(min), and min, current and max are counted in steps from it.
  static readonly int[] Steps = { 100, 125, 150, 175, 200, 225, 250, 300, 350, 400, 450, 500 };

  // Each active source once: its adapter LUID (8 bytes) and source id (4), as a path holds them.
  static List<byte[]> Sources() {
    uint np, nm;
    int e = GetDisplayConfigBufferSizes(2, out np, out nm);
    if (e != 0) throw new Exception("GetDisplayConfigBufferSizes: " + e);
    var paths = new byte[np * 72];
    var modes = new byte[nm * 64];
    e = QueryDisplayConfig(2, ref np, paths, ref nm, modes, IntPtr.Zero);
    if (e != 0) throw new Exception("QueryDisplayConfig: " + e);
    var seen = new HashSet<string>();
    var list = new List<byte[]>();
    for (int i = 0; i < np; i++) {
      var src = new byte[12];
      Array.Copy(paths, i * 72, src, 0, 12);
      if (seen.Add(BitConverter.ToString(src))) list.Add(src);
    }
    return list;
  }

  // A device information packet: type, size, the source's adapter and id.
  static byte[] Packet(int type, int size, byte[] src) {
    var p = new byte[size];
    BitConverter.GetBytes(type).CopyTo(p, 0);
    BitConverter.GetBytes(size).CopyTo(p, 4);
    Array.Copy(src, 0, p, 8, 12);
    return p;
  }

  // The source's GDI device name (\\.\DISPLAY1), as EnumDisplayDevices names it.
  static string GdiName(byte[] src) {
    var p = Packet(1, 84, src);
    int e = DisplayConfigGetDeviceInfo(p);
    if (e != 0) return "error " + e;
    return System.Text.Encoding.Unicode.GetString(p, 20, 64).TrimEnd('\0');
  }

  // "device,current,allowed (a/b/c),recommended" for each active source.
  public static List<string> Scales() {
    var list = new List<string>();
    foreach (var src in Sources()) {
      var p = Packet(-3, 32, src);
      int e = DisplayConfigGetDeviceInfo(p);
      if (e != 0) { list.Add(GdiName(src) + ",error " + e + ",,"); continue; }
      int min = BitConverter.ToInt32(p, 20), cur = BitConverter.ToInt32(p, 24), max = BitConverter.ToInt32(p, 28);
      int rec = Math.Abs(min);
      var allowed = new List<string>();
      for (int k = 0; k <= rec + max && k < Steps.Length; k++) allowed.Add(Steps[k].ToString());
      int ci = rec + cur;
      string current = (ci >= 0 && ci < Steps.Length) ? Steps[ci].ToString() : "unknown";
      string recommended = rec < Steps.Length ? Steps[rec].ToString() : "unknown";
      list.Add(GdiName(src) + "," + current + "," + String.Join("/", allowed.ToArray()) + "," + recommended);
    }
    return list;
  }

  // Set the scale of the source named gdiName: "ok", or why not.
  public static string SetScale(string gdiName, int percent) {
    foreach (var src in Sources()) {
      if (!String.Equals(GdiName(src), gdiName, StringComparison.OrdinalIgnoreCase)) continue;
      var g = Packet(-3, 32, src);
      int e = DisplayConfigGetDeviceInfo(g);
      if (e != 0) return "reading the scale failed: " + e;
      int min = BitConverter.ToInt32(g, 20), max = BitConverter.ToInt32(g, 28);
      int rec = Math.Abs(min);
      int idx = Array.IndexOf(Steps, percent);
      if (idx < 0) return percent + " is not a scale step";
      int rel = idx - rec;
      if (rel < min || rel > max) return percent + "% is not a scale this display allows";
      var s = Packet(-4, 24, src);
      BitConverter.GetBytes(rel).CopyTo(s, 20);
      e = DisplayConfigSetDeviceInfo(s);
      return e == 0 ? "ok" : "setting the scale failed: " + e;
    }
    return "no active display source is named " + gdiName;
  }
}
'@

function Write-Line($value) { $value | ConvertTo-Json -Compress -Depth 6 }

function Get-Scales {
  @([P21Win]::Scales() | ForEach-Object {
      $f = $_ -split ','
      [ordered]@{ device = $f[0]; current = $f[1]; allowed = @(($f[2] -split '/') | Where-Object { $_ }); recommended = $f[3] }
    })
}

function Get-PrimaryDevice {
  $p = @([P21Win]::Modes() | Where-Object { ($_ -split ',')[4] -eq '1' }) | Select-Object -First 1
  if ($p) { ($p -split ',')[5] } else { '' }
}

switch ($Mode) {
  'facts' {
    $session = [System.Diagnostics.Process]::GetCurrentProcess().SessionId
    $logon = @(Get-Process -Name LogonUI -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq $session }).Count -gt 0
    $me = [Security.Principal.WindowsIdentity]::GetCurrent()
    $elevated = ([Security.Principal.WindowsPrincipal]$me).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    $modes = @([P21Win]::Modes() | ForEach-Object {
        $f = $_ -split ','
        [ordered]@{ left = [int]$f[0]; top = [int]$f[1]; width = [int]$f[2]; height = [int]$f[3]; primary = ($f[4] -eq '1'); device = $f[5] }
      })
    $raw = @([P21Win]::Dpis())
    $dpis = @($raw | Where-Object { $_ -ne 'error' } | ForEach-Object {
        $f = $_ -split ','
        [ordered]@{ left = [int]$f[0]; top = [int]$f[1]; width = [int]$f[2]; height = [int]$f[3]; primary = ($f[4] -eq '1'); dpi = [int]$f[5] }
      })
    Write-Line ([ordered]@{ sessionId = $session; logonUi = $logon; elevated = $elevated; modes = $modes; dpis = $dpis; dpiErrors = @($raw | Where-Object { $_ -eq 'error' }).Count })
  }
  'scale' {
    $device = Get-PrimaryDevice
    $before = Get-Scales
    $result = $null
    if ($Set -gt 0) {
      $result = [P21Win]::SetScale($device, $Set)
      Start-Sleep -Seconds 3
    }
    Write-Line ([ordered]@{ primaryDevice = $device; before = @($before); set = $Set; setResult = $result; after = @(Get-Scales) })
  }
  'task-run' {
    if ($Name -notmatch '^aicc-p21-[A-Za-z0-9-]{1,40}$') { throw "the task name $Name is not one of P21's" }
    # The token's own name: an SSH session's USERDOMAIN does not name the computer.
    $user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $action = New-ScheduledTaskAction -Execute $Exe -Argument $Arguments -WorkingDirectory $Dir
    $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
    Register-ScheduledTask -TaskName $Name -Action $action -Principal $principal -Settings $settings -Force | Out-Null
    Start-ScheduledTask -TaskName $Name
    Write-Line ([ordered]@{ task = $Name; user = $user; started = $true })
  }
  'task-info' {
    if ($Name -notmatch '^aicc-p21-[A-Za-z0-9-]{1,40}$') { throw "the task name $Name is not one of P21's" }
    $task = Get-ScheduledTask -TaskName $Name
    $info = Get-ScheduledTaskInfo -TaskName $Name
    Write-Line ([ordered]@{ task = $Name; state = [string]$task.State; lastResult = ('0x{0:X8}' -f $info.LastTaskResult) })
  }
  'task-remove' {
    if ($Name -notmatch '^aicc-p21-[A-Za-z0-9-]{1,40}$') { throw "the task name $Name is not one of P21's" }
    $task = Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
    if ($task) {
      Stop-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
      Unregister-ScheduledTask -TaskName $Name -Confirm:$false
    }
    Write-Line ([ordered]@{ task = $Name; removed = [bool]$task })
  }
}
