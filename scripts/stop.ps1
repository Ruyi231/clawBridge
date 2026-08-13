[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "lib\ClawBridge.Common.ps1")

$paths = Get-ClawBridgePaths
$mutex = $null
$requestToken = $null
try {
  $mutex = Enter-ClawBridgeLifecycleLock -ProjectRoot $paths.ProjectRoot
  $runtime = Get-ClawBridgeRuntimeState -Paths $paths
  if (-not $runtime.Running) {
    if ($runtime.State -eq "unmanaged-ambiguous") {
      $candidateList = $runtime.CandidatePids -join ", "
      throw "Found an untracked relative dist/src/app.js process (PID: $candidateList), but its repository cannot be verified. Refusing to stop it automatically."
    }
    if ($runtime.State -eq "stale") {
      Remove-ClawBridgePidFile -PidFile $paths.PidFile
      Write-Output "ClawBridge was not running; removed a stale PID file."
    } else {
      Write-Output "ClawBridge is not running."
    }
    return
  }

  $requestToken = [Guid]::NewGuid().ToString("N")
  $request = [ordered]@{
    version = 1
    token = $requestToken
    pid = [int]$runtime.Pid
    requestedAt = [DateTimeOffset]::Now.ToString("o")
  }
  $requestDirectory = Split-Path -Parent $paths.ShutdownFile
  New-Item -ItemType Directory -Force -Path $requestDirectory | Out-Null
  $intent = [ordered]@{
    version = 1
    token = $requestToken
    pid = [int]$runtime.Pid
    requestedAt = [DateTimeOffset]::Now.ToString("o")
  }
  $temporaryIntent = Join-Path $requestDirectory ("clawbridge.stop-intent.{0}.tmp" -f $requestToken)
  try {
    [IO.File]::WriteAllText(
      $temporaryIntent,
      ($intent | ConvertTo-Json -Compress),
      (New-Object Text.UTF8Encoding($false))
    )
    Move-Item -LiteralPath $temporaryIntent -Destination $paths.StopIntentFile -Force
  } finally {
    if (Test-Path -LiteralPath $temporaryIntent) {
      Remove-Item -LiteralPath $temporaryIntent -Force
    }
  }
  $temporaryRequest = Join-Path $requestDirectory ("clawbridge.shutdown.{0}.tmp" -f $requestToken)
  try {
    [IO.File]::WriteAllText(
      $temporaryRequest,
      ($request | ConvertTo-Json -Compress),
      (New-Object Text.UTF8Encoding($false))
    )
    Move-Item -LiteralPath $temporaryRequest -Destination $paths.ShutdownFile -Force
  } finally {
    if (Test-Path -LiteralPath $temporaryRequest) {
      Remove-Item -LiteralPath $temporaryRequest -Force
    }
  }

  Write-Output "Requested graceful shutdown for ClawBridge PID $($runtime.Pid)."
  $deadline = [DateTime]::UtcNow.AddSeconds(15)
  do {
    Start-Sleep -Milliseconds 250
    try {
      $remaining = @(Get-CimInstance Win32_Process -Filter "ProcessId = $($runtime.Pid)" -ErrorAction Stop) | Select-Object -First 1
    } catch {
      $remainingNative = Get-Process -Id $runtime.Pid -ErrorAction SilentlyContinue
      if ($null -eq $remainingNative) {
        $remaining = $null
      } else {
        throw "Unable to verify whether ClawBridge stopped; refusing to continue with an unverified PID: $($_.Exception.Message)"
      }
    }
  } while ($null -ne $remaining -and [DateTime]::UtcNow -lt $deadline)

  if ($null -ne $remaining) {
    Write-Warning "Graceful shutdown timed out after 15 seconds; terminating the verified ClawBridge process tree."
    Stop-ClawBridgeVerifiedProcessTree -OriginalProcess $runtime.Process -ProcessId $runtime.Pid -EntryPoint $paths.EntryPoint
  }

  Remove-ClawBridgePidFile -PidFile $paths.PidFile -ExpectedPid $runtime.Pid
  Remove-ClawBridgeReadyFile -ReadyFile $paths.ReadyFile -ExpectedPid $runtime.Pid -AllowInvalid
  Write-Output "ClawBridge stopped."
} finally {
  if (-not [string]::IsNullOrWhiteSpace($requestToken)) {
    Remove-ClawBridgeShutdownRequest -ShutdownFile $paths.ShutdownFile -Token $requestToken
  }
  Exit-ClawBridgeLifecycleLock -Mutex $mutex
}
