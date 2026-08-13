[CmdletBinding()]
param(
  [switch]$Build,
  [string]$Config = "config/local.yaml",
  [string]$CredentialPath
)

$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
. (Join-Path $PSScriptRoot "lib\ClawBridge.Common.ps1")
$credentialPathWasProvided = -not [string]::IsNullOrWhiteSpace($CredentialPath)
$credentialPathForTask = if ($credentialPathWasProvided) { [IO.Path]::GetFullPath($CredentialPath) } else { Get-ClawBridgeCredentialPath }
$registration = Get-ClawBridgeAutostartRegistration -ProjectRoot $projectRoot -CredentialPath $credentialPathForTask

& (Join-Path $PSScriptRoot "stop.ps1")
if ($registration.Installed) {
  foreach ($taskDescriptor in @(
      @{ Task = $registration.ProjectTask; Legacy = $false },
      @{ Task = $registration.LegacyTask; Legacy = $true }
    )) {
    if ($null -eq $taskDescriptor.Task) { continue }
    $taskName = [string]$taskDescriptor.Task.TaskName
    $task = Get-ClawBridgeScheduledTaskByName -TaskName $taskName
    if ($null -eq $task) { continue }
    Assert-ClawBridgeScheduledTaskOwned -Task $task -ProjectRoot $projectRoot -CredentialPath $credentialPathForTask -Legacy:([bool]$taskDescriptor.Legacy) | Out-Null
    if ([string]$task.State -eq "Running") {
      Stop-ScheduledTask -TaskName $taskName -ErrorAction Stop
      $taskDeadline = [DateTime]::UtcNow.AddSeconds(15)
      do {
        Start-Sleep -Milliseconds 250
        $task = Get-ClawBridgeScheduledTaskByName -TaskName $taskName
        if ($null -eq $task) { break }
        Assert-ClawBridgeScheduledTaskOwned -Task $task -ProjectRoot $projectRoot -CredentialPath $credentialPathForTask -Legacy:([bool]$taskDescriptor.Legacy) | Out-Null
      } while ([string]$task.State -eq "Running" -and [DateTime]::UtcNow -lt $taskDeadline)
      if ($null -ne $task -and [string]$task.State -eq "Running") {
        throw "The previous owned ClawBridge supervised task '$taskName' did not stop within 15 seconds."
      }
    }
  }
}
if ($Build) {
  Push-Location $projectRoot
  try {
    & npm run build
    if ($LASTEXITCODE -ne 0) {
      throw "npm run build failed with exit code $LASTEXITCODE."
    }
  } finally {
    Pop-Location
  }
  if ($registration.Installed) {
    [void](Install-ClawBridgePrivateRuntime -ProjectRoot $projectRoot)
  }
}

$arguments = @{ Config = $Config }
if ($credentialPathWasProvided) {
  $arguments.CredentialPath = $CredentialPath
}
& (Join-Path $PSScriptRoot "start.ps1") @arguments
