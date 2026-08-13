[CmdletBinding()]
param(
  [switch]$Foreground,
  [switch]$Supervised,
  [string]$Config = "config/local.yaml",
  [string]$CredentialPath
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "lib\ClawBridge.Common.ps1")

$credentialPathWasProvided = -not [string]::IsNullOrWhiteSpace($CredentialPath)

if ($Foreground -and $Supervised) {
  throw "Foreground and Supervised are mutually exclusive."
}

$paths = Get-ClawBridgePaths
$taskName = Get-ClawBridgeTaskName -ProjectRoot $paths.IdentityRoot
if ([string]::IsNullOrWhiteSpace($CredentialPath)) {
  $CredentialPath = Get-ClawBridgeCredentialPath
}
$configPath = if ([IO.Path]::IsPathRooted($Config)) { $Config } else { Join-Path $paths.ProjectRoot $Config }

if (-not (Test-Path -LiteralPath $paths.EntryPoint -PathType Leaf)) {
  throw "Build output is missing. Run npm run build first."
}
if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
  throw "Configuration file not found: $configPath"
}
$configPath = (Resolve-Path -LiteralPath $configPath).Path

# When login autostart is installed, ordinary GUI/CLI starts should run the
# supervised scheduled-task instance. This preserves crash restart behavior
# after a manual stop/restart. Explicit foreground/custom-config launches stay
# local and are never silently redirected to the registered task.
$usesDefaultConfig = $Config -eq "config/local.yaml"
$autostartRegistration = $null
if (-not $Foreground -and -not $Supervised -and -not $credentialPathWasProvided -and $usesDefaultConfig) {
  $autostartRegistration = Get-ClawBridgeAutostartRegistration -ProjectRoot $paths.ProjectRoot -CredentialPath $CredentialPath
}
if ($null -ne $autostartRegistration -and $autostartRegistration.Installed) {
  $taskName = $autostartRegistration.TaskName
  $existingRuntime = Get-ClawBridgeRuntimeState -Paths $paths
  if ($existingRuntime.Running) {
    Write-Output "ClawBridge is already running with PID $($existingRuntime.Pid)."
    return
  }
  if ($existingRuntime.BlockStart) {
    throw "A conflicting ClawBridge-like Node process is already present; the supervised task was not started."
  }

  $autostartRegistration = Get-ClawBridgeAutostartRegistration -ProjectRoot $paths.ProjectRoot -CredentialPath $CredentialPath
  if (-not $autostartRegistration.Installed) {
    throw "The validated ClawBridge scheduled task disappeared before it could be started."
  }
  $taskName = $autostartRegistration.TaskName
  $existingTask = $autostartRegistration.Task
  if ([string]$existingTask.State -eq "Running") {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction Stop
    $wrapperDeadline = [DateTime]::UtcNow.AddSeconds(15)
    do {
      Start-Sleep -Milliseconds 250
      $autostartRegistration = Get-ClawBridgeAutostartRegistration -ProjectRoot $paths.ProjectRoot -CredentialPath $CredentialPath
      $existingTask = if ($null -eq $autostartRegistration.Task) { $null } else { $autostartRegistration.Task }
    } while ($null -ne $existingTask -and [string]$existingTask.State -eq "Running" -and [DateTime]::UtcNow -lt $wrapperDeadline)
    if ($null -ne $existingTask -and [string]$existingTask.State -eq "Running") {
      throw "The previous ClawBridge supervised wrapper did not stop within 15 seconds."
    }
  }
  $autostartRegistration = Get-ClawBridgeAutostartRegistration -ProjectRoot $paths.ProjectRoot -CredentialPath $CredentialPath
  if (-not $autostartRegistration.Installed -or -not [string]::Equals($autostartRegistration.TaskName, $taskName, [StringComparison]::OrdinalIgnoreCase)) {
    throw "The validated ClawBridge scheduled task changed before it could be started."
  }
  Start-ScheduledTask -TaskName $taskName
  $taskDeadline = [DateTime]::UtcNow.AddSeconds(50)
  do {
    Start-Sleep -Milliseconds 250
    $taskRuntime = Get-ClawBridgeRuntimeState -Paths $paths
    $taskReady = Get-ClawBridgeReadyState -Paths $paths -Runtime $taskRuntime
    if ($taskReady.Healthy) {
      Write-Output "ClawBridge supervised task is ready with PID $($taskRuntime.Pid)."
      return
    }
  } while ([DateTime]::UtcNow -lt $taskDeadline)

  $taskInfo = Get-ScheduledTaskInfo -TaskName $taskName -ErrorAction SilentlyContinue
  $lastResult = if ($null -eq $taskInfo) { "unknown" } else { [string]$taskInfo.LastTaskResult }
  throw "The ClawBridge supervised task did not become ready within 50 seconds (LastTaskResult=$lastResult). Check logs/clawbridge.err.log."
}

$nodeCommand = Get-Command node -CommandType Application -ErrorAction Stop
$nodeExecutable = $nodeCommand.Source

$mutex = $null
$credentials = $null
$previousEnvironment = $null
$process = $null
try {
  $mutex = Enter-ClawBridgeLifecycleLock -ProjectRoot $paths.ProjectRoot
  $runtime = Get-ClawBridgeRuntimeState -Paths $paths
  if ($runtime.Running) {
    Write-Output "ClawBridge is already running with PID $($runtime.Pid). New credentials or configuration were not applied; use restart.ps1 to apply them."
    return
  }
  if ($runtime.BlockStart) {
    $candidateList = if ($null -ne $runtime.CandidatePids) { $runtime.CandidatePids -join ", " } else { [string]$runtime.Pid }
    throw "Found an untracked Node process using relative dist/src/app.js (PID: $candidateList). Its working directory cannot be verified safely, so startup was blocked to avoid a duplicate Bridge. Stop that npm/node process and retry."
  }
  if ($runtime.State -eq "stale") {
    Remove-ClawBridgePidFile -PidFile $paths.PidFile
  }
  if (Test-Path -LiteralPath $paths.ShutdownFile -PathType Leaf) {
    Remove-Item -LiteralPath $paths.ShutdownFile -Force
  }
  Remove-ClawBridgeStopIntent -StopIntentFile $paths.StopIntentFile
  if (Test-Path -LiteralPath $paths.ReadyFile -PathType Leaf) {
    Remove-ClawBridgeReadyFile -ReadyFile $paths.ReadyFile -AllowInvalid
  }

  $credentials = Read-ClawBridgeCredentials -CredentialPath $CredentialPath
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $paths.PidFile), $paths.LogDirectory | Out-Null
  Move-ClawBridgeLogToArchive -Path $paths.StdoutLog
  Move-ClawBridgeLogToArchive -Path $paths.StderrLog
  $previousEnvironment = Set-ClawBridgeProcessEnvironment -Credentials $credentials -ConfigPath $configPath -ShutdownFile $paths.ShutdownFile -ReadyFile $paths.ReadyFile

  $startArguments = @{
    FilePath = $nodeExecutable
    ArgumentList = @("`"$($paths.EntryPoint)`"")
    WorkingDirectory = $paths.ProjectRoot
    PassThru = $true
  }
  if ($Foreground) {
    $startArguments.NoNewWindow = $true
  } else {
    $startArguments.WindowStyle = "Hidden"
    $startArguments.RedirectStandardOutput = $paths.StdoutLog
    $startArguments.RedirectStandardError = $paths.StderrLog
  }
  $process = Start-Process @startArguments
  Set-Content -LiteralPath $paths.PidFile -Value $process.Id -Encoding ASCII
} finally {
  if ($null -ne $previousEnvironment) {
    Restore-ClawBridgeProcessEnvironment -Previous $previousEnvironment
  }
  $credentials = $null
  $previousEnvironment = $null
  Exit-ClawBridgeLifecycleLock -Mutex $mutex
}

try {
  $originalProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $($process.Id)" -ErrorAction Stop
} catch {
  $metadataError = $_.Exception.Message
  $cleanupConfirmed = $process.HasExited
  $cleanupDetail = ""
  if (-not $cleanupConfirmed) {
    $taskkillOutput = & taskkill.exe /PID $process.Id /T /F 2>&1
    $taskkillExitCode = $LASTEXITCODE
    if ($taskkillExitCode -eq 0) {
      try {
        $cleanupConfirmed = $process.WaitForExit(5000)
        if (-not $cleanupConfirmed) {
          $cleanupDetail = "taskkill returned success, but PID $($process.Id) did not exit within 5 seconds"
        }
      } catch {
        $cleanupDetail = $_.Exception.Message
      }
    } else {
      $cleanupDetail = "taskkill exit code ${taskkillExitCode}: $($taskkillOutput -join ' ')"
    }
  }
  if ($cleanupConfirmed) {
    Remove-ClawBridgePidFile -PidFile $paths.PidFile -ExpectedPid $process.Id
    Remove-ClawBridgeReadyFile -ReadyFile $paths.ReadyFile -ExpectedPid $process.Id -AllowInvalid
    throw "ClawBridge was started but Windows process metadata could not verify it. Its process tree was stopped or had already exited: $metadataError"
  }
  throw "ClawBridge was started but Windows process metadata could not verify it, and cleanup could not be confirmed. PID $($process.Id) was retained for safe follow-up. Metadata error: $metadataError. Cleanup error: $cleanupDetail"
}
$ready = $false
$deadline = [DateTime]::UtcNow.AddSeconds(45)
while ([DateTime]::UtcNow -lt $deadline) {
  $process.Refresh()
  if ($process.HasExited) {
    Remove-ClawBridgePidFile -PidFile $paths.PidFile -ExpectedPid $process.Id
    Remove-ClawBridgeReadyFile -ReadyFile $paths.ReadyFile -ExpectedPid $process.Id -AllowInvalid
    $detail = if (-not $Foreground -and (Test-Path -LiteralPath $paths.StderrLog)) {
      (Get-Content -LiteralPath $paths.StderrLog -Tail 8) -join [Environment]::NewLine
    } else {
      "No redirected error log is available."
    }
    throw "ClawBridge exited before reporting ready (exit code $($process.ExitCode)).`n$detail"
  }

  $runtime = [pscustomobject]@{ Running = $true; Pid = $process.Id }
  $readyState = Get-ClawBridgeReadyState -Paths $paths -Runtime $runtime
  if ($readyState.Healthy) {
    $ready = $true
    break
  }
  Start-Sleep -Milliseconds 250
}

if (-not $ready) {
  # Only discard the PID after the verified tree-stop helper has confirmed the
  # parent is gone. If verification itself fails, retaining the PID is safer
  # than turning a live process into an untracked instance.
  Stop-ClawBridgeVerifiedProcessTree -OriginalProcess $originalProcess -ProcessId $process.Id -EntryPoint $paths.EntryPoint
  Remove-ClawBridgePidFile -PidFile $paths.PidFile -ExpectedPid $process.Id
  Remove-ClawBridgeReadyFile -ReadyFile $paths.ReadyFile -ExpectedPid $process.Id -AllowInvalid
  $detail = if (-not $Foreground -and (Test-Path -LiteralPath $paths.StderrLog)) {
    (Get-Content -LiteralPath $paths.StderrLog -Tail 8) -join [Environment]::NewLine
  } else {
    "No redirected error log is available."
  }
  throw "ClawBridge did not report ready within 45 seconds. Its verified process tree was stopped.`n$detail"
}

Write-Output "ClawBridge is ready with PID $($process.Id)."
if (-not $Foreground) {
  Write-Output "Logs: $($paths.StdoutLog) and $($paths.StderrLog)"
}

if ($Foreground -or $Supervised) {
  $waitCompleted = $false
  try {
    $process.WaitForExit()
    $waitCompleted = $true
    $exitCode = $process.ExitCode
  } finally {
    $wasUserStop = Test-ClawBridgeStopIntent -StopIntentFile $paths.StopIntentFile -ProcessId $process.Id
    if (-not $waitCompleted) {
      & (Join-Path $PSScriptRoot "stop.ps1") 2>&1 | Write-Output
    }
    Remove-ClawBridgePidFile -PidFile $paths.PidFile -ExpectedPid $process.Id
    Remove-ClawBridgeReadyFile -ReadyFile $paths.ReadyFile -ExpectedPid $process.Id -AllowInvalid
    Remove-ClawBridgeStopIntent -StopIntentFile $paths.StopIntentFile -ExpectedPid $process.Id
  }
  $taskStillInstalled = $false
  if ($Supervised -and -not $wasUserStop) {
    $taskStillInstalled = Test-ClawBridgeAutostartInstalled -ProjectRoot $paths.ProjectRoot -CredentialPath $CredentialPath
  }
  if ($exitCode -ne 0 -and $taskStillInstalled -and -not $wasUserStop) {
    throw "ClawBridge exited with code $exitCode."
  }
}
