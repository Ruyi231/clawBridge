[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("Install", "Uninstall", "Status")]
  [string]$Action,
  [switch]$Json,
  [string]$CredentialPath
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "lib\ClawBridge.Common.ps1")

$projectRoot = Get-ClawBridgeProjectRoot
$paths = Get-ClawBridgePaths -ProjectRoot $projectRoot
if ([string]::IsNullOrWhiteSpace($CredentialPath)) {
  $CredentialPath = Get-ClawBridgeCredentialPath
}
$CredentialPath = [IO.Path]::GetFullPath($CredentialPath)
$taskName = Get-ClawBridgeTaskName -ProjectRoot $projectRoot

function Stop-ClawBridgeOwnedTaskInstance {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [switch]$Legacy
  )

  $task = Get-ClawBridgeScheduledTaskByName -TaskName $Name
  if ($null -eq $task) { return }
  Assert-ClawBridgeScheduledTaskOwned -Task $task -ProjectRoot $projectRoot -CredentialPath $CredentialPath -Legacy:$Legacy | Out-Null
  if ([string]$task.State -ne "Running") { return }

  Stop-ScheduledTask -TaskName $Name -ErrorAction Stop
  $deadline = [DateTime]::UtcNow.AddSeconds(15)
  do {
    Start-Sleep -Milliseconds 250
    $task = Get-ClawBridgeScheduledTaskByName -TaskName $Name
    if ($null -eq $task) { return }
    Assert-ClawBridgeScheduledTaskOwned -Task $task -ProjectRoot $projectRoot -CredentialPath $CredentialPath -Legacy:$Legacy | Out-Null
  } while ([string]$task.State -eq "Running" -and [DateTime]::UtcNow -lt $deadline)
  if ([string]$task.State -eq "Running") {
    throw "The owned scheduled task '$Name' did not stop within 15 seconds."
  }
}

function Unregister-ClawBridgeOwnedTask {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [switch]$Legacy
  )

  $task = Get-ClawBridgeScheduledTaskByName -TaskName $Name
  if ($null -eq $task) { return }
  Assert-ClawBridgeScheduledTaskOwned -Task $task -ProjectRoot $projectRoot -CredentialPath $CredentialPath -Legacy:$Legacy | Out-Null
  Unregister-ScheduledTask -TaskName $Name -Confirm:$false -ErrorAction Stop
}

switch ($Action) {
  "Install" {
    if (-not (Test-Path -LiteralPath $CredentialPath -PathType Leaf)) {
      throw "Credentials are not configured. Save them before enabling autostart."
    }
    $sourceEntryPoint = Join-Path $projectRoot "dist\src\app.js"
    if (-not (Test-Path -LiteralPath $sourceEntryPoint -PathType Leaf)) {
      throw "Build output is missing. Run npm run build before enabling autostart."
    }
    $registration = Get-ClawBridgeAutostartRegistration -ProjectRoot $projectRoot -CredentialPath $CredentialPath
    if ($null -ne $registration.LegacyTask -and [string]$registration.LegacyTask.State -eq "Running") {
      throw "The validated legacy 'ClawBridge' task is still running. Stop ClawBridge, wait for shutdown to finish, and enable autostart again so it can be migrated safely."
    }
    # Stop the live instance before copying its SQLite database/WAL and runtime
    # files. The scheduled task runs from a private, current-user-only snapshot
    # so a broadly shared development workspace is never trusted at logon.
    & (Join-Path $PSScriptRoot "stop.ps1") | Out-Null
    foreach ($taskDescriptor in @(
        @{ Task = $registration.ProjectTask; Legacy = $false },
        @{ Task = $registration.LegacyTask; Legacy = $true }
      )) {
      if ($null -eq $taskDescriptor.Task) { continue }
      Stop-ClawBridgeOwnedTaskInstance -Name ([string]$taskDescriptor.Task.TaskName) -Legacy:([bool]$taskDescriptor.Legacy)
      Unregister-ClawBridgeOwnedTask -Name ([string]$taskDescriptor.Task.TaskName) -Legacy:([bool]$taskDescriptor.Legacy)
    }

    $runtimeRoot = Install-ClawBridgePrivateRuntime -ProjectRoot $projectRoot
    $paths = Get-ClawBridgePaths -ProjectRoot $projectRoot
    if (-not (Test-ClawBridgePathEqual -Left $paths.ProjectRoot -Right $runtimeRoot)) {
      throw "The private autostart runtime manifest could not be verified after installation."
    }

    $nodeExecutable = (Get-Command node -CommandType Application -ErrorAction Stop).Source
    $configPath = Join-Path $runtimeRoot "config\local.yaml"
    $codexCommandText = & $nodeExecutable -e "const fs=require('fs');const YAML=require('yaml');const value=YAML.parse(fs.readFileSync(process.argv[1],'utf8'))?.codex?.command;if(typeof value!=='string'||!value.trim())process.exit(2);process.stdout.write(value.trim())" $configPath
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($codexCommandText)) {
      throw "Unable to resolve codex.command from config/local.yaml for autostart security validation."
    }
    $codexCommandText = ([string]$codexCommandText).Trim()
    $codexExecutable = if ([IO.Path]::IsPathRooted($codexCommandText)) {
      (Resolve-Path -LiteralPath $codexCommandText -ErrorAction Stop).Path
    } else {
      (Get-Command $codexCommandText -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
    }
    Assert-ClawBridgeAutostartSecurity -Paths $paths -ExecutablePaths @($nodeExecutable, $codexExecutable)

    $powershellExecutable = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
    $startScript = Join-Path $runtimeRoot "scripts\start.ps1"
    $taskArguments = "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$startScript`" -Supervised -CredentialPath `"$CredentialPath`""
    $userId = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $taskAction = New-ScheduledTaskAction -Execute $powershellExecutable -Argument $taskArguments -WorkingDirectory $runtimeRoot
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
    $principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
    $createdProjectTask = $false
    Register-ScheduledTask -TaskName $taskName -Action $taskAction -Trigger $trigger -Principal $principal -Settings $settings -Description "Start the private local ClawBridge runtime when this user signs in." -ErrorAction Stop | Out-Null
    $createdProjectTask = $true

    $verified = Get-ClawBridgeAutostartRegistration -ProjectRoot $projectRoot -CredentialPath $CredentialPath
    if ($null -eq $verified.ProjectTask) {
      throw "The project-specific ClawBridge task could not be verified after registration."
    }
    Write-Output "ClawBridge autostart was enabled for $userId as $taskName."
    Write-Output "Private runtime: $runtimeRoot"
  }
  "Uninstall" {
    $registration = Get-ClawBridgeAutostartRegistration -ProjectRoot $projectRoot -CredentialPath $CredentialPath
    if (-not $registration.Installed) {
      Write-Output "ClawBridge autostart is already disabled."
    } else {
      # Stop the supervised wrapper before unregistering it. The Node child is
      # first asked to shut down gracefully so Codex threads are released.
      & (Join-Path $PSScriptRoot "stop.ps1") | Out-Null
      if ($null -ne $registration.ProjectTask) {
        Stop-ClawBridgeOwnedTaskInstance -Name ([string]$registration.ProjectTask.TaskName)
      }
      if ($null -ne $registration.LegacyTask) {
        Stop-ClawBridgeOwnedTaskInstance -Name ([string]$registration.LegacyTask.TaskName) -Legacy
      }
      if ($null -ne $registration.ProjectTask) {
        Unregister-ClawBridgeOwnedTask -Name ([string]$registration.ProjectTask.TaskName)
      }
      if ($null -ne $registration.LegacyTask) {
        Unregister-ClawBridgeOwnedTask -Name ([string]$registration.LegacyTask.TaskName) -Legacy
      }
      Write-Output "ClawBridge autostart was disabled."
    }
  }
  "Status" {
    $registration = Get-ClawBridgeAutostartRegistration -ProjectRoot $projectRoot -CredentialPath $CredentialPath
    $task = $registration.Task
    $result = [ordered]@{
      installed = $registration.Installed
      state = if ($null -eq $task) { "NotInstalled" } else { [string]$task.State }
      taskName = if ($null -eq $task) { $taskName } else { [string]$task.TaskName }
      migrationRequired = $registration.MigrationRequired
    }
    if ($Json) {
      $result | ConvertTo-Json -Compress
    } elseif ($result.installed) {
      Write-Output "installed state=$($result.state)"
    } else {
      Write-Output "not installed"
    }
  }
}
