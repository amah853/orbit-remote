param(
  [int]$Width = 0,
  [int]$Height = 0,
  [int]$RefreshRate = 60,
  [switch]$Exact,
  [switch]$List,
  [switch]$Current
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class OrbitDisplay {
  public class ModeInfo {
    public int width;
    public int height;
    public int refresh;
    public int index;
  }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
  public struct DEVMODE {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName;
    public short dmSpecVersion;
    public short dmDriverVersion;
    public short dmSize;
    public short dmDriverExtra;
    public int dmFields;
    public int dmPositionX;
    public int dmPositionY;
    public int dmDisplayOrientation;
    public int dmDisplayFixedOutput;
    public short dmColor;
    public short dmDuplex;
    public short dmYResolution;
    public short dmTTOption;
    public short dmCollate;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName;
    public short dmLogPixels;
    public int dmBitsPerPel;
    public int dmPelsWidth;
    public int dmPelsHeight;
    public int dmDisplayFlags;
    public int dmDisplayFrequency;
    public int dmICMMethod;
    public int dmICMIntent;
    public int dmMediaType;
    public int dmDitherType;
    public int dmReserved1;
    public int dmReserved2;
    public int dmPanningWidth;
    public int dmPanningHeight;
  }

  [DllImport("user32.dll", CharSet = CharSet.Ansi)]
  private static extern bool EnumDisplaySettings(string deviceName, int modeNum, ref DEVMODE mode);

  [DllImport("user32.dll", CharSet = CharSet.Ansi)]
  private static extern int ChangeDisplaySettings(ref DEVMODE mode, int flags);

  public static ModeInfo[] GetModes() {
    var modes = new List<ModeInfo>();
    for (var index = 0; ; index++) {
      var mode = new DEVMODE();
      mode.dmSize = (short)Marshal.SizeOf(typeof(DEVMODE));
      if (!EnumDisplaySettings(null, index, ref mode)) break;
      if (mode.dmPelsWidth >= 640 && mode.dmPelsHeight >= 480) {
        modes.Add(new ModeInfo { width = mode.dmPelsWidth, height = mode.dmPelsHeight, refresh = mode.dmDisplayFrequency, index = index });
      }
    }
    return modes.ToArray();
  }

  public static ModeInfo GetCurrent() {
    var mode = new DEVMODE();
    mode.dmSize = (short)Marshal.SizeOf(typeof(DEVMODE));
    if (!EnumDisplaySettings(null, -1, ref mode)) throw new InvalidOperationException("Could not read the current display mode.");
    return new ModeInfo { width = mode.dmPelsWidth, height = mode.dmPelsHeight, refresh = mode.dmDisplayFrequency, index = -1 };
  }

  public static ModeInfo Apply(int index) {
    var mode = new DEVMODE();
    mode.dmSize = (short)Marshal.SizeOf(typeof(DEVMODE));
    if (!EnumDisplaySettings(null, index, ref mode)) throw new InvalidOperationException("Could not read the selected display mode.");
    var result = ChangeDisplaySettings(ref mode, 1);
    if (result != 0) throw new InvalidOperationException("Windows rejected the display mode with result " + result + ".");
    return new ModeInfo { width = mode.dmPelsWidth, height = mode.dmPelsHeight, refresh = mode.dmDisplayFrequency, index = index };
  }
}
'@

$modes = [OrbitDisplay]::GetModes()

if ($Current) {
  $currentMode = [OrbitDisplay]::GetCurrent()
  [pscustomobject]@{ width = $currentMode.width; height = $currentMode.height; refresh = $currentMode.refresh } | ConvertTo-Json -Compress
  exit 0
}

$uniqueModes = $modes | Sort-Object width,height,refresh -Unique
if ($List) {
  $uniqueModes | Select-Object width,height,refresh | ConvertTo-Json -Compress
  exit 0
}

if ($Width -lt 640 -or $Height -lt 480) { throw 'A valid width and height are required.' }

if ($Exact) {
  $candidates = $modes | Where-Object { $_.width -eq $Width -and $_.height -eq $Height }
} else {
  $targetRatio = $Width / [double]$Height
  $targetPixels = $Width * [double]$Height
  $candidates = $modes | ForEach-Object {
    $ratio = $_.width / [double]$_.height
    $pixels = $_.width * [double]$_.height
    $score = [Math]::Abs([Math]::Log($ratio / $targetRatio)) * 6 + [Math]::Abs([Math]::Log($pixels / $targetPixels))
    [pscustomobject]@{ mode = $_; score = $score }
  } | Sort-Object score | Select-Object -First 12 | ForEach-Object { $_.mode }
}

$selected = $candidates | Sort-Object @{Expression={ [Math]::Abs($_.refresh - $RefreshRate) }}, @{Expression={ $_.refresh }} | Select-Object -First 1
if (-not $selected) { throw "The display does not support ${Width}x${Height}." }

$applied = [OrbitDisplay]::Apply($selected.index)
[pscustomobject]@{ success = $true; width = $applied.width; height = $applied.height; refresh = $applied.refresh } | ConvertTo-Json -Compress
