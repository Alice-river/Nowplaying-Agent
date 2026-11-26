# Reads the playback info of one desktop app from Windows SMTC and prints one JSON line per second.
# -Match is a regular expression for the session's SourceAppUserModelId.
# {"running":false} when the app is not found. Cover (base64) is attached only when the track changes.
param([Parameter(Mandatory = $true)][string]$Match)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType = WindowsRuntime]

$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]
function Await($op, $type) {
  $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
  $t.Wait(5000) | Out-Null
  $t.Result
}

$tManager = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]
$tProps = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties]
$null = [Windows.Storage.Streams.IInputStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
$tStream = [Windows.Storage.Streams.IRandomAccessStreamWithContentType]
$asStream = [System.IO.WindowsRuntimeStreamExtensions].GetMethod('AsStreamForRead', [Type[]]@([Windows.Storage.Streams.IInputStream]))

function Get-Cover($props) {
  try {
    if (-not $props.Thumbnail) { return '' }
    $stream = Await ($props.Thumbnail.OpenReadAsync()) $tStream
    $reader = $asStream.Invoke($null, @($stream))
    $ms = New-Object System.IO.MemoryStream
    $reader.CopyTo($ms)
    if ($ms.Length -eq 0) { return '' }
    $mime = if ($stream.ContentType) { $stream.ContentType } else { 'image/jpeg' }
    return "data:$mime;base64," + [Convert]::ToBase64String($ms.ToArray())
  } catch { return '' }
}

$manager = $null
$lastKey = ''
$coverDone = $false
while ($true) {
  try {
    if (-not $manager) { $manager = Await ($tManager::RequestAsync()) $tManager }
    $session = $null
    foreach ($s in $manager.GetSessions()) {
      if ($s.SourceAppUserModelId -match $Match) { $session = $s; break }
    }
    if (-not $session) {
      @{ running = $false } | ConvertTo-Json -Compress
      $lastKey = ''
    } else {
      $props = Await ($session.TryGetMediaPropertiesAsync()) $tProps
      $tl = $session.GetTimelineProperties()
      $status = $session.GetPlaybackInfo().PlaybackStatus.ToString()
      $key = "$($props.Title)`n$($props.Artist)`n$($props.AlbumTitle)"
      $o = [ordered]@{
        running = $true
        playing = ($status -eq 'Playing')
        title = [string]$props.Title
        artist = [string]$props.Artist
        album = [string]$props.AlbumTitle
        position = [int][Math]::Max(0, ($tl.Position - $tl.StartTime).TotalSeconds)
        duration = [int][Math]::Max(0, ($tl.EndTime - $tl.StartTime).TotalSeconds)
      }
      if ($key -ne $lastKey) { $lastKey = $key; $coverDone = $false }
      if (-not $coverDone) {
        $c = Get-Cover $props
        if ($c) { $o.cover = $c; $coverDone = $true }
      }
      $o | ConvertTo-Json -Compress
    }
  } catch {
    $manager = $null
    @{ running = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
  }
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds 1000
}
