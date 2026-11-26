# Runs media commands for NowPlaying. Reads one JSON request per line from stdin and writes one JSON reply per line.
# request: {"id":1,"command":"next","prefer":["spotify"],"targets":[{"match":"spotify","processes":["Spotify"]}]}
#   command: play | pause | next | previous | volume_up | volume_down | volume_get
# reply:   {"id":1,"ok":true,"volume":60}  or  {"id":1,"ok":false,"error":"no_session"}
# Playback goes through Windows SMTC. Volume changes only the audio sessions of the chosen app.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]

Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;

namespace NowPlaying
{
    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    class MMDeviceEnumeratorClass { }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceEnumerator
    {
        [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
    }

    [ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceCollection
    {
        [PreserveSig] int GetCount(out int count);
        [PreserveSig] int Item(int index, out IMMDevice device);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDevice
    {
        [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object instance);
    }

    [ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioSessionManager2
    {
        [PreserveSig] int GetAudioSessionControl(IntPtr sessionId, int flags, out IntPtr control);
        [PreserveSig] int GetSimpleAudioVolume(IntPtr sessionId, int flags, out IntPtr volume);
        [PreserveSig] int GetSessionEnumerator(out IAudioSessionEnumerator sessions);
    }

    [ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioSessionEnumerator
    {
        [PreserveSig] int GetCount(out int count);
        [PreserveSig] int GetSession(int index, [MarshalAs(UnmanagedType.IUnknown)] out object session);
    }

    // The unused methods only keep the vtable order.
    [ComImport, Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioSessionControl2
    {
        [PreserveSig] int GetState(out int state);
        [PreserveSig] int GetDisplayName(out IntPtr name);
        [PreserveSig] int SetDisplayName(IntPtr name, IntPtr context);
        [PreserveSig] int GetIconPath(out IntPtr path);
        [PreserveSig] int SetIconPath(IntPtr path, IntPtr context);
        [PreserveSig] int GetGroupingParam(out Guid group);
        [PreserveSig] int SetGroupingParam(IntPtr group, IntPtr context);
        [PreserveSig] int RegisterAudioSessionNotification(IntPtr events);
        [PreserveSig] int UnregisterAudioSessionNotification(IntPtr events);
        [PreserveSig] int GetSessionIdentifier(out IntPtr id);
        [PreserveSig] int GetSessionInstanceIdentifier(out IntPtr id);
        [PreserveSig] int GetProcessId(out uint processId);
    }

    [ComImport, Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface ISimpleAudioVolume
    {
        [PreserveSig] int SetMasterVolume(float level, ref Guid context);
        [PreserveSig] int GetMasterVolume(out float level);
        [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid context);
        [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
    }

    public static class AppVolume
    {
        // Adds delta to every audio session of the named processes. Returns the new volume (0-100), or -1 if there is none.
        public static int Change(string[] processNames, float delta)
        {
            int result = -1;
            var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorClass();
            IMMDeviceCollection devices;
            Marshal.ThrowExceptionForHR(enumerator.EnumAudioEndpoints(0 /* render */, 1 /* active */, out devices));
            int deviceCount;
            devices.GetCount(out deviceCount);
            for (int d = 0; d < deviceCount; d++)
            {
                IMMDevice device;
                if (devices.Item(d, out device) != 0) continue;
                var iid = typeof(IAudioSessionManager2).GUID;
                object instance;
                if (device.Activate(ref iid, 23 /* CLSCTX_ALL */, IntPtr.Zero, out instance) != 0) continue;
                IAudioSessionEnumerator sessions;
                if (((IAudioSessionManager2)instance).GetSessionEnumerator(out sessions) != 0) continue;
                int count;
                sessions.GetCount(out count);
                for (int i = 0; i < count; i++)
                {
                    object session;
                    if (sessions.GetSession(i, out session) != 0) continue;
                    uint pid;
                    if (((IAudioSessionControl2)session).GetProcessId(out pid) < 0 || pid == 0) continue;
                    string name;
                    try { name = Process.GetProcessById((int)pid).ProcessName; }
                    catch (ArgumentException) { continue; }
                    if (Array.FindIndex(processNames, p => string.Equals(p, name, StringComparison.OrdinalIgnoreCase)) < 0) continue;
                    var volume = (ISimpleAudioVolume)session;
                    float level;
                    volume.GetMasterVolume(out level);
                    if (delta != 0)
                    {
                        level = Math.Max(0f, Math.Min(1f, (float)Math.Round(level + delta, 2)));
                        var context = Guid.Empty;
                        Marshal.ThrowExceptionForHR(volume.SetMasterVolume(level, ref context));
                        if (delta > 0) volume.SetMute(false, ref context);
                    }
                    result = Math.Max(result, (int)Math.Round(level * 100));
                }
            }
            return result;
        }
    }
}
'@

$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]
function Await($op, $type) {
  $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
  if (-not $t.Wait(5000)) { throw 'timeout' }
  $t.Result
}
$tManager = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]
$manager = $null
$step = 0.1

# Picks the session to control: playing and preferred, playing, preferred, Windows' current one, any.
# For "play" the app that is shown now comes first.
function Select-MediaSession($request) {
  if (-not $script:manager) { $script:manager = Await ($tManager::RequestAsync()) $tManager }
  $current = $script:manager.GetCurrentSession()
  $found = @()
  $index = 0
  foreach ($s in $script:manager.GetSessions()) {
    $id = [string]$s.SourceAppUserModelId
    $target = $null
    foreach ($t in $request.targets) { if ($id -match $t.match) { $target = $t; break } }
    if (-not $target) { continue }
    $playing = $s.GetPlaybackInfo().PlaybackStatus.ToString() -eq 'Playing'
    $preferred = $false
    foreach ($m in $request.prefer) { if ($id -match $m) { $preferred = $true } }
    $isCurrent = $current -and ([string]$current.SourceAppUserModelId -eq $id)
    if ($request.command -eq 'play') { $score = 8 * $preferred + 2 * [bool]$isCurrent }
    else { $score = 8 * $playing + 4 * $preferred + 2 * [bool]$isCurrent }
    $found += [pscustomobject]@{ Session = $s; Target = $target; Score = $score; Index = $index++ }
  }
  $found | Sort-Object @{ Expression = 'Score'; Descending = $true }, Index | Select-Object -First 1
}

function Invoke-MediaRequest($request) {
  $chosen = Select-MediaSession $request
  if (-not $chosen) { return @{ ok = $false; error = 'no_session' } }
  $s = $chosen.Session
  switch ($request.command) {
    'play' { $done = Await ($s.TryPlayAsync()) ([bool]) }
    'pause' { $done = Await ($s.TryPauseAsync()) ([bool]) }
    'next' { $done = Await ($s.TrySkipNextAsync()) ([bool]) }
    'previous' { $done = Await ($s.TrySkipPreviousAsync()) ([bool]) }
    { $_ -in 'volume_up', 'volume_down', 'volume_get' } {
      $delta = 0
      if ($request.command -eq 'volume_up') { $delta = $step }
      if ($request.command -eq 'volume_down') { $delta = -$step }
      $volume = [NowPlaying.AppVolume]::Change([string[]]@($chosen.Target.processes), [float]$delta)
      if ($volume -lt 0) { return @{ ok = $false; error = 'no_audio' } }
      return @{ ok = $true; volume = $volume }
    }
    default { return @{ ok = $false; error = 'unknown' } }
  }
  if ($done) { @{ ok = $true } } else { @{ ok = $false; error = 'rejected' } }
}

while ($null -ne ($line = [Console]::In.ReadLine())) {
  if (-not $line.Trim()) { continue }
  $request = $null
  try {
    $request = $line | ConvertFrom-Json
    $reply = Invoke-MediaRequest $request
  } catch {
    $manager = $null
    [Console]::Error.WriteLine($_.Exception.Message)
    $reply = @{ ok = $false; error = 'failed' }
  }
  if ($request) { $reply.id = $request.id }
  [Console]::Out.WriteLine(($reply | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
}
