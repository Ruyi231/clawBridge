[CmdletBinding()]
param(
  [switch]$Json,
  [string]$CredentialPath
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "lib\ClawBridge.Common.ps1")

$paths = Get-ClawBridgePaths
if ([string]::IsNullOrWhiteSpace($CredentialPath)) {
  $CredentialPath = Get-ClawBridgeCredentialPath
}
$CredentialPath = [IO.Path]::GetFullPath($CredentialPath)
$runtime = Get-ClawBridgeRuntimeState -Paths $paths
$readyState = Get-ClawBridgeReadyState -Paths $paths -Runtime $runtime
$autostartInstalled = $false
$autostartConflict = $false
$autostartError = $null
try {
  $autostartRegistration = Get-ClawBridgeAutostartRegistration -ProjectRoot $paths.ProjectRoot -CredentialPath $CredentialPath
  $autostartInstalled = $autostartRegistration.Installed
} catch {
  $autostartConflict = $true
  $autostartError = $_.Exception.Message
}
$result = [ordered]@{
  state = if ($runtime.Running) { $readyState.State } else { $runtime.State }
  running = $runtime.Running
  healthy = $readyState.Healthy
  pid = $runtime.Pid
  managed = $runtime.Managed
  # BlockStart is also true for a healthy managed instance because a second
  # instance must not be launched.  Expose startupBlocked only for an actual
  # conflict where no managed Bridge is running; otherwise the GUI would label
  # every healthy process as a conflicting npm/node process.
  startupBlocked = (-not $runtime.Running -and $runtime.BlockStart)
  credentialsConfigured = Test-Path -LiteralPath $CredentialPath -PathType Leaf
  autostartInstalled = $autostartInstalled
  autostartConflict = $autostartConflict
  autostartError = $autostartError
  stdoutLog = $paths.StdoutLog
  stderrLog = $paths.StderrLog
}

if ($Json) {
  $result | ConvertTo-Json -Compress
} elseif ($runtime.Running -and $readyState.Healthy) {
  Write-Output "running healthy=true pid=$($runtime.Pid)"
} elseif ($runtime.Running) {
  Write-Output "$($readyState.State) healthy=false pid=$($runtime.Pid)"
} elseif ($runtime.State -eq "stale") {
  Write-Output "stopped (stale PID file)"
} else {
  Write-Output "stopped"
}
