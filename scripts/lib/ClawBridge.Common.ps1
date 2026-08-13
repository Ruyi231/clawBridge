Set-StrictMode -Version 3.0

$script:ClawBridgeTaskPrefix = "ClawBridge"

function Get-ClawBridgeProjectRoot {
  return (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
}

function Get-ClawBridgeCredentialPath {
  $localAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
  if ([string]::IsNullOrWhiteSpace($localAppData)) {
    throw "The current user's LocalAppData directory could not be resolved."
  }
  return Join-Path $localAppData "ClawBridge\credentials.json"
}

function Get-ClawBridgeAutostartRuntimeManifestPath {
  $localAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
  if ([string]::IsNullOrWhiteSpace($localAppData)) {
    throw "The current user's LocalAppData directory could not be resolved."
  }
  return Join-Path $localAppData "ClawBridge\autostart-runtime.json"
}

function Get-ClawBridgePrivateRuntimeRoot {
  param([string]$ProjectRoot = (Get-ClawBridgeProjectRoot))

  $localAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
  $sha256 = [Security.Cryptography.SHA256]::Create()
  try {
    $hash = $sha256.ComputeHash([Text.Encoding]::UTF8.GetBytes(([IO.Path]::GetFullPath($ProjectRoot)).ToLowerInvariant()))
    $suffix = ([BitConverter]::ToString($hash)).Replace("-", "").Substring(0, 12)
  } finally {
    $sha256.Dispose()
  }
  return Join-Path $localAppData "Programs\ClawBridge\$suffix"
}

function Set-ClawBridgePrivateTreeAcl {
  param([Parameter(Mandatory = $true)][string]$Root)

  $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $systemSid = New-Object Security.Principal.SecurityIdentifier("S-1-5-18")
  $administratorsSid = New-Object Security.Principal.SecurityIdentifier("S-1-5-32-544")
  $inherit = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
  $acl = New-Object Security.AccessControl.DirectorySecurity
  $acl.SetOwner($currentSid)
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($sid in @($currentSid, $systemSid, $administratorsSid)) {
    $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, "FullControl", $inherit, "None", "Allow")
    [void]$acl.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $Root -AclObject $acl
}

function Install-ClawBridgePrivateRuntime {
  param([string]$ProjectRoot = (Get-ClawBridgeProjectRoot))

  $sourceRoot = [IO.Path]::GetFullPath($ProjectRoot)
  $runtimeRoot = Get-ClawBridgePrivateRuntimeRoot -ProjectRoot $sourceRoot
  $runtimeParent = Split-Path -Parent $runtimeRoot
  $stagingRoot = "$runtimeRoot.staging.$([Guid]::NewGuid().ToString('N'))"
  $backupRoot = "$runtimeRoot.previous.$([Guid]::NewGuid().ToString('N'))"
  $manifestPath = Get-ClawBridgeAutostartRuntimeManifestPath
  $manifestDirectory = Split-Path -Parent $manifestPath
  $required = @("dist", "node_modules", "scripts", "config", "package.json", "package-lock.json")
  foreach ($name in $required) {
    if (-not (Test-Path -LiteralPath (Join-Path $sourceRoot $name))) {
      throw "Cannot install the private autostart runtime because a required path is missing: $name"
    }
  }

  New-Item -ItemType Directory -Force -Path $runtimeParent, $stagingRoot, $manifestDirectory | Out-Null
  try {
    foreach ($name in $required) {
      Copy-Item -LiteralPath (Join-Path $sourceRoot $name) -Destination (Join-Path $stagingRoot $name) -Recurse -Force
    }
    foreach ($mutableName in @("data", "logs")) {
      $existingMutable = Join-Path $runtimeRoot $mutableName
      $sourceMutable = Join-Path $sourceRoot $mutableName
      $mutableSource = if (Test-Path -LiteralPath $existingMutable) { $existingMutable } elseif (Test-Path -LiteralPath $sourceMutable) { $sourceMutable } else { $null }
      if ($null -ne $mutableSource) {
        Copy-Item -LiteralPath $mutableSource -Destination (Join-Path $stagingRoot $mutableName) -Recurse -Force
      }
    }
    Set-ClawBridgePrivateTreeAcl -Root $stagingRoot
    if (Test-Path -LiteralPath $runtimeRoot) {
      Move-Item -LiteralPath $runtimeRoot -Destination $backupRoot
    }
    Move-Item -LiteralPath $stagingRoot -Destination $runtimeRoot

    $manifest = [ordered]@{
      version = 1
      sourceRoot = $sourceRoot
      runtimeRoot = $runtimeRoot
      installedAt = [DateTimeOffset]::Now.ToString("o")
    }
    $temporaryManifest = "$manifestPath.$([Guid]::NewGuid().ToString('N')).tmp"
    $utf8NoBom = New-Object Text.UTF8Encoding($false)
    [IO.File]::WriteAllText($temporaryManifest, ($manifest | ConvertTo-Json -Compress), $utf8NoBom)
    Move-Item -LiteralPath $temporaryManifest -Destination $manifestPath -Force
    if (Test-Path -LiteralPath $backupRoot) {
      Remove-Item -LiteralPath $backupRoot -Recurse -Force
    }
    return $runtimeRoot
  } catch {
    if (-not (Test-Path -LiteralPath $runtimeRoot) -and (Test-Path -LiteralPath $backupRoot)) {
      Move-Item -LiteralPath $backupRoot -Destination $runtimeRoot
    }
    throw
  } finally {
    if (Test-Path -LiteralPath $stagingRoot) {
      Remove-Item -LiteralPath $stagingRoot -Recurse -Force
    }
  }
}

function Get-ClawBridgeAutostartRuntimeManifest {
  param([string]$ProjectRoot = (Get-ClawBridgeProjectRoot))

  $manifestPath = Get-ClawBridgeAutostartRuntimeManifestPath
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { return $null }
  try {
    $document = Get-Content -Raw -Encoding UTF8 -LiteralPath $manifestPath | ConvertFrom-Json
    if ([int]$document.version -ne 1) { return $null }
    $sourceRoot = [IO.Path]::GetFullPath([string]$document.sourceRoot)
    $runtimeRoot = [IO.Path]::GetFullPath([string]$document.runtimeRoot)
    $requestedRoot = [IO.Path]::GetFullPath($ProjectRoot)
    if (-not (Test-ClawBridgePathEqual -Left $requestedRoot -Right $sourceRoot) -and
        -not (Test-ClawBridgePathEqual -Left $requestedRoot -Right $runtimeRoot)) {
      return $null
    }
    if (-not (Test-Path -LiteralPath (Join-Path $runtimeRoot "dist\src\app.js") -PathType Leaf)) {
      return $null
    }
    return [pscustomobject]@{
      Path = $manifestPath
      SourceRoot = $sourceRoot
      RuntimeRoot = $runtimeRoot
    }
  } catch {
    return $null
  }
}

function Get-ClawBridgeTaskName {
  param([string]$ProjectRoot = (Get-ClawBridgeProjectRoot))

  $sha256 = [Security.Cryptography.SHA256]::Create()
  try {
    $hash = $sha256.ComputeHash([Text.Encoding]::UTF8.GetBytes(([IO.Path]::GetFullPath($ProjectRoot)).ToLowerInvariant()))
    $suffix = ([BitConverter]::ToString($hash)).Replace("-", "").Substring(0, 12)
  } finally {
    $sha256.Dispose()
  }
  return "$($script:ClawBridgeTaskPrefix)-$suffix"
}

function Protect-ClawBridgeString {
  param([Parameter(Mandatory = $true)][string]$Value)

  $secureValue = ConvertTo-SecureString -String $Value -AsPlainText -Force
  try {
    return ConvertFrom-SecureString -SecureString $secureValue
  } finally {
    $secureValue.Dispose()
  }
}

function Unprotect-ClawBridgeString {
  param([Parameter(Mandatory = $true)][string]$Value)

  $secureValue = ConvertTo-SecureString -String $Value
  $pointer = [IntPtr]::Zero
  try {
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureValue)
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  } finally {
    if ($pointer -ne [IntPtr]::Zero) {
      [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    }
    $secureValue.Dispose()
  }
}

function Read-ClawBridgeCredentialDocument {
  param([Parameter(Mandatory = $true)][string]$CredentialPath)

  $CredentialPath = [IO.Path]::GetFullPath($CredentialPath)
  if (-not (Test-Path -LiteralPath $CredentialPath -PathType Leaf)) {
    throw "Credentials are not configured. Open ClawBridge Manager and save them first."
  }

  $document = Get-Content -Raw -Encoding UTF8 -LiteralPath $CredentialPath | ConvertFrom-Json
  if ($document.version -ne 1 -or $document.protection -ne "WindowsCurrentUser") {
    throw "Unsupported credentials file format."
  }
  foreach ($propertyName in @("appId", "appSecret", "allowedOpenId")) {
    if ([string]::IsNullOrWhiteSpace([string]$document.$propertyName)) {
      throw "Credentials file is missing $propertyName."
    }
  }
  return $document
}

function Read-ClawBridgeCredentialSummary {
  param([Parameter(Mandatory = $true)][string]$CredentialPath)

  $secureSecret = $null
  try {
    $document = Read-ClawBridgeCredentialDocument -CredentialPath $CredentialPath
    $appId = Unprotect-ClawBridgeString -Value ([string]$document.appId)
    $openId = Unprotect-ClawBridgeString -Value ([string]$document.allowedOpenId)
    $secureSecret = ConvertTo-SecureString -String ([string]$document.appSecret)
    $hasSecret = $secureSecret.Length -gt 0
    if ($appId -notmatch '^cli_[0-9a-fA-F]{16}$' -or $openId -notmatch '^ou_[A-Za-z0-9_-]+$' -or -not $hasSecret) {
      throw "Decrypted credentials failed validation."
    }

    # Deliberately omit the decrypted App Secret. The manager only needs to
    # know that a reusable encrypted value exists.
    return [pscustomobject]@{
      AppId = $appId
      OpenId = $openId
      HasSecret = $hasSecret
    }
  } catch {
    throw "Unable to read credential summary for the current Windows user: $($_.Exception.Message)"
  } finally {
    if ($null -ne $secureSecret) {
      $secureSecret.Dispose()
    }
  }
}

function Save-ClawBridgeCredentials {
  param(
    [Parameter(Mandatory = $true)][string]$AppId,
    [Security.SecureString]$AppSecret,
    [Parameter(Mandatory = $true)][string]$OpenId,
    [Parameter(Mandatory = $true)][string]$CredentialPath,
    [switch]$PreserveExistingSecret
  )

  $trimmedAppId = $AppId.Trim()
  $trimmedOpenId = $OpenId.Trim()
  if ($trimmedAppId -notmatch '^cli_[0-9a-fA-F]{16}$') {
    throw "App ID must use the Feishu format cli_ followed by 16 hexadecimal characters."
  }
  if ($trimmedOpenId -notmatch '^ou_[A-Za-z0-9_-]+$') {
    throw "Open ID must start with ou_."
  }

  $CredentialPath = [IO.Path]::GetFullPath($CredentialPath)
  $encryptedSecret = $null
  if ($PreserveExistingSecret) {
    if ($null -ne $AppSecret) {
      throw "AppSecret and PreserveExistingSecret are mutually exclusive."
    }
    try {
      $existingDocument = Read-ClawBridgeCredentialDocument -CredentialPath $CredentialPath
      $encryptedSecret = [string]$existingDocument.appSecret
      $existingSecureSecret = ConvertTo-SecureString -String $encryptedSecret
      try {
        if ($existingSecureSecret.Length -eq 0) {
          throw "The existing App Secret is empty."
        }
      } finally {
        $existingSecureSecret.Dispose()
      }
    } catch {
      throw "Unable to preserve the existing App Secret: $($_.Exception.Message)"
    }
  } else {
    if ($null -eq $AppSecret -or $AppSecret.Length -eq 0) {
      throw "App Secret cannot be empty."
    }
    $encryptedSecret = ConvertFrom-SecureString -SecureString $AppSecret
  }

  $directory = Split-Path -Parent $CredentialPath
  New-Item -ItemType Directory -Force -Path $directory | Out-Null

  $document = [ordered]@{
    version = 1
    protection = "WindowsCurrentUser"
    updatedAt = [DateTimeOffset]::Now.ToString("o")
    appId = Protect-ClawBridgeString -Value $trimmedAppId
    appSecret = $encryptedSecret
    allowedOpenId = Protect-ClawBridgeString -Value $trimmedOpenId
  }
  $temporaryPath = Join-Path $directory ("credentials.{0}.tmp" -f [Guid]::NewGuid().ToString("N"))
  try {
    $document | ConvertTo-Json | Set-Content -LiteralPath $temporaryPath -Encoding UTF8
    Move-Item -LiteralPath $temporaryPath -Destination $CredentialPath -Force
  } finally {
    if (Test-Path -LiteralPath $temporaryPath) {
      Remove-Item -LiteralPath $temporaryPath -Force
    }
  }
}

function Read-ClawBridgeCredentials {
  param([Parameter(Mandatory = $true)][string]$CredentialPath)

  try {
    $document = Read-ClawBridgeCredentialDocument -CredentialPath $CredentialPath
    $appId = Unprotect-ClawBridgeString -Value ([string]$document.appId)
    $appSecret = Unprotect-ClawBridgeString -Value ([string]$document.appSecret)
    $openId = Unprotect-ClawBridgeString -Value ([string]$document.allowedOpenId)
    if ($appId -notmatch '^cli_[0-9a-fA-F]{16}$' -or [string]::IsNullOrWhiteSpace($appSecret) -or $openId -notmatch '^ou_[A-Za-z0-9_-]+$') {
      throw "Decrypted credentials failed validation."
    }

    return [pscustomobject]@{
      AppId = $appId
      AppSecret = $appSecret
      OpenId = $openId
    }
  } catch {
    throw "Unable to read credentials for the current Windows user: $($_.Exception.Message)"
  }
}

function Get-ClawBridgePaths {
  param([string]$ProjectRoot = (Get-ClawBridgeProjectRoot))

  $sourceRoot = [IO.Path]::GetFullPath($ProjectRoot)
  $manifest = Get-ClawBridgeAutostartRuntimeManifest -ProjectRoot $sourceRoot
  $effectiveRoot = if ($null -eq $manifest) { $sourceRoot } else { $manifest.RuntimeRoot }
  $identityRoot = if ($null -eq $manifest) { $sourceRoot } else { $manifest.SourceRoot }

  return [pscustomobject]@{
    ProjectRoot = $effectiveRoot
    IdentityRoot = $identityRoot
    SourceRoot = $sourceRoot
    EntryPoint = Join-Path $effectiveRoot "dist\src\app.js"
    PidFile = Join-Path $effectiveRoot "data\clawbridge.pid"
    ShutdownFile = Join-Path $effectiveRoot "data\clawbridge.shutdown"
    StopIntentFile = Join-Path $effectiveRoot "data\clawbridge.stop-intent.json"
    ReadyFile = Join-Path $effectiveRoot "data\clawbridge.ready.json"
    LogDirectory = Join-Path $effectiveRoot "logs"
    StdoutLog = Join-Path $effectiveRoot "logs\clawbridge.out.log"
    StderrLog = Join-Path $effectiveRoot "logs\clawbridge.err.log"
  }
}

function Test-ClawBridgeProcess {
  param(
    [Parameter(Mandatory = $true)]$Process,
    [Parameter(Mandatory = $true)][string]$EntryPoint
  )

  if ($null -eq $Process -or [string]::IsNullOrWhiteSpace([string]$Process.CommandLine)) {
    return $false
  }
  $commandLine = [string]$Process.CommandLine
  $windowsPath = $EntryPoint.Replace('/', '\')
  $forwardPath = $EntryPoint.Replace('\', '/')
  # Start-Process launches `node <absolute-entrypoint>`; require the entrypoint
  # to be the first argument, not merely an unrelated token later in the line.
  $tokens = @([regex]::Matches($commandLine, '"(?:\\.|[^"\\])*"|\S+') | ForEach-Object {
      $_.Value.Trim('"')
    })
  if ($tokens.Count -lt 2) {
    return $false
  }
  return $tokens[1].Equals($windowsPath, [StringComparison]::OrdinalIgnoreCase) -or
    $tokens[1].Equals($forwardPath, [StringComparison]::OrdinalIgnoreCase)
}

function Get-ClawBridgeRuntimeState {
  param([Parameter(Mandatory = $true)]$Paths)

  $pidFileState = "missing"
  $bridgePid = 0
  if (Test-Path -LiteralPath $Paths.PidFile -PathType Leaf) {
    $rawPid = (Get-Content -Raw -LiteralPath $Paths.PidFile).Trim()
    if ([int]::TryParse($rawPid, [ref]$bridgePid) -and $bridgePid -gt 0) {
      try {
        $process = @(Get-CimInstance Win32_Process -Filter "ProcessId = $bridgePid" -ErrorAction Stop) | Select-Object -First 1
      } catch {
        throw "Unable to verify the managed ClawBridge process with Windows process metadata. Startup and shutdown are blocked to avoid acting on the wrong PID: $($_.Exception.Message)"
      }
      if ($null -ne $process -and (Test-ClawBridgeProcess -Process $process -EntryPoint $Paths.EntryPoint)) {
        return [pscustomobject]@{
          State = "running"
          Running = $true
          BlockStart = $true
          Managed = $true
          Pid = $bridgePid
          Process = $process
        }
      }
    }
    $pidFileState = "stale"
  }

  # Older launches (for example, `npm start`) may not have created a PID file.
  # An absolute entry-point match is safe to identify. A relative match cannot
  # be attributed to this repository because Win32_Process exposes no cwd, so
  # it blocks a duplicate start but is never adopted or stopped automatically.
  $relativePattern = '(?i)(?:^|\s|["''])(?:\.\\|\./)?dist[\\/]src[\\/]app\.js(?:["'']|\s|$)'
  $ambiguous = @()
  try {
    $nodeProcesses = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction Stop)
  } catch {
    throw "Unable to enumerate Node processes with Windows process metadata. Startup is blocked to avoid creating a duplicate ClawBridge: $($_.Exception.Message)"
  }
  foreach ($candidate in $nodeProcesses) {
    if (Test-ClawBridgeProcess -Process $candidate -EntryPoint $Paths.EntryPoint) {
      return [pscustomobject]@{
        State = "unmanaged"
        Running = $true
        BlockStart = $true
        Managed = $false
        Pid = [int]$candidate.ProcessId
        Process = $candidate
      }
    }
    if (-not [string]::IsNullOrWhiteSpace([string]$candidate.CommandLine) -and [string]$candidate.CommandLine -match $relativePattern) {
      $ambiguous += [int]$candidate.ProcessId
    }
  }
  if ($ambiguous.Count -gt 0) {
    return [pscustomobject]@{
      State = "unmanaged-ambiguous"
      Running = $false
      BlockStart = $true
      Managed = $false
      Pid = $ambiguous[0]
      CandidatePids = @($ambiguous)
      Process = $null
    }
  }

  return [pscustomobject]@{
    State = if ($pidFileState -eq "stale") { "stale" } else { "stopped" }
    Running = $false
    BlockStart = $false
    Managed = $false
    Pid = if ($bridgePid -gt 0) { $bridgePid } else { $null }
    Process = $null
  }
}

function Remove-ClawBridgePidFile {
  param(
    [Parameter(Mandatory = $true)][string]$PidFile,
    [int]$ExpectedPid = 0
  )

  if (-not (Test-Path -LiteralPath $PidFile -PathType Leaf)) {
    return
  }
  if ($ExpectedPid -gt 0) {
    $current = (Get-Content -Raw -LiteralPath $PidFile).Trim()
    if ($current -ne [string]$ExpectedPid) {
      return
    }
  }
  Remove-Item -LiteralPath $PidFile -Force
}

function Enter-ClawBridgeLifecycleLock {
  param([Parameter(Mandatory = $true)][string]$ProjectRoot)

  $sha256 = [Security.Cryptography.SHA256]::Create()
  try {
    $hash = $sha256.ComputeHash([Text.Encoding]::UTF8.GetBytes($ProjectRoot.ToLowerInvariant()))
    $suffix = ([BitConverter]::ToString($hash)).Replace("-", "").Substring(0, 16)
  } finally {
    $sha256.Dispose()
  }

  $mutexName = "Global\ClawBridge_$suffix"
  try {
    $mutex = New-Object Threading.Mutex($false, $mutexName)
  } catch [UnauthorizedAccessException] {
    throw "The global ClawBridge lifecycle lock exists but cannot be opened by this Windows user. Startup and shutdown are blocked to avoid a cross-session duplicate."
  }
  try {
    $acquired = $mutex.WaitOne([TimeSpan]::FromSeconds(15))
  } catch [Threading.AbandonedMutexException] {
    $acquired = $true
  }
  if (-not $acquired) {
    $mutex.Dispose()
    throw "Another ClawBridge lifecycle operation is still running."
  }
  return $mutex
}

function Exit-ClawBridgeLifecycleLock {
  param($Mutex)

  if ($null -eq $Mutex) {
    return
  }
  try {
    $Mutex.ReleaseMutex()
  } finally {
    $Mutex.Dispose()
  }
}

function Set-ClawBridgeProcessEnvironment {
  param(
    [Parameter(Mandatory = $true)]$Credentials,
    [Parameter(Mandatory = $true)][string]$ConfigPath,
    [Parameter(Mandatory = $true)][string]$ShutdownFile,
    [Parameter(Mandatory = $true)][string]$ReadyFile
  )

  $names = @(
    "CLAWBRIDGE_FEISHU_APP_ID",
    "CLAWBRIDGE_FEISHU_APP_SECRET",
    "CLAWBRIDGE_FEISHU_ALLOWED_OPEN_ID",
    "CLAWBRIDGE_CONFIG",
    "CLAWBRIDGE_SHUTDOWN_FILE",
    "CLAWBRIDGE_READY_FILE"
  )
  $previous = @{}
  foreach ($name in $names) {
    $previous[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
  }
  [Environment]::SetEnvironmentVariable("CLAWBRIDGE_FEISHU_APP_ID", $Credentials.AppId, "Process")
  [Environment]::SetEnvironmentVariable("CLAWBRIDGE_FEISHU_APP_SECRET", $Credentials.AppSecret, "Process")
  [Environment]::SetEnvironmentVariable("CLAWBRIDGE_FEISHU_ALLOWED_OPEN_ID", $Credentials.OpenId, "Process")
  [Environment]::SetEnvironmentVariable("CLAWBRIDGE_CONFIG", $ConfigPath, "Process")
  [Environment]::SetEnvironmentVariable("CLAWBRIDGE_SHUTDOWN_FILE", $ShutdownFile, "Process")
  [Environment]::SetEnvironmentVariable("CLAWBRIDGE_READY_FILE", $ReadyFile, "Process")
  return $previous
}

function Get-ClawBridgeReadyState {
  param(
    [Parameter(Mandatory = $true)]$Paths,
    [Parameter(Mandatory = $true)]$Runtime
  )

  if (-not $Runtime.Running) {
    return [pscustomobject]@{ State = "stopped"; Healthy = $false; Document = $null }
  }
  if (-not (Test-Path -LiteralPath $Paths.ReadyFile -PathType Leaf)) {
    $processAgeSeconds = $null
    try {
      $nativeProcess = Get-Process -Id $Runtime.Pid -ErrorAction Stop
      $processAgeSeconds = ([DateTime]::Now - $nativeProcess.StartTime).TotalSeconds
    } catch {
      $processAgeSeconds = $null
    }
    $state = if ($null -ne $processAgeSeconds -and $processAgeSeconds -le 45) { "starting" } else { "unhealthy" }
    return [pscustomobject]@{ State = $state; Healthy = $false; Document = $null }
  }

  try {
    $document = Get-Content -Raw -Encoding UTF8 -LiteralPath $Paths.ReadyFile | ConvertFrom-Json
    $valid = [int]$document.version -eq 1 -and [int]$document.pid -eq [int]$Runtime.Pid -and [string]$document.state -eq "ready"
    return [pscustomobject]@{
      State = if ($valid) { "running" } else { "unhealthy" }
      Healthy = $valid
      Document = $document
    }
  } catch {
    return [pscustomobject]@{ State = "unhealthy"; Healthy = $false; Document = $null }
  }
}

function Remove-ClawBridgeReadyFile {
  param(
    [Parameter(Mandatory = $true)][string]$ReadyFile,
    [int]$ExpectedPid = 0,
    [switch]$AllowInvalid
  )

  if (-not (Test-Path -LiteralPath $ReadyFile -PathType Leaf)) {
    return
  }
  if ($ExpectedPid -le 0) {
    Remove-Item -LiteralPath $ReadyFile -Force
    return
  }
  try {
    $document = Get-Content -Raw -Encoding UTF8 -LiteralPath $ReadyFile | ConvertFrom-Json
    if ([int]$document.pid -eq $ExpectedPid) {
      Remove-Item -LiteralPath $ReadyFile -Force
    }
  } catch {
    if ($AllowInvalid) {
      Remove-Item -LiteralPath $ReadyFile -Force
    }
  }
}

function Stop-ClawBridgeVerifiedProcessTree {
  param(
    [Parameter(Mandatory = $true)]$OriginalProcess,
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [Parameter(Mandatory = $true)][string]$EntryPoint
  )

  try {
    $current = @(Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop) | Select-Object -First 1
  } catch {
    $native = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if ($null -eq $native) {
      return
    }
    throw "Unable to re-verify ClawBridge PID $ProcessId before terminating it; refusing to act: $($_.Exception.Message)"
  }
  if ($null -eq $current) {
    return
  }
  $sameCommand = [string]$current.CommandLine -eq [string]$OriginalProcess.CommandLine
  $sameCreation = [string]$current.CreationDate -eq [string]$OriginalProcess.CreationDate
  $sameName = [string]$current.Name -eq [string]$OriginalProcess.Name
  if (-not ($sameCommand -and $sameCreation -and $sameName -and (Test-ClawBridgeProcess -Process $current -EntryPoint $EntryPoint))) {
    throw "PID $ProcessId changed identity; refusing to terminate its process tree."
  }

  $taskkillOutput = & taskkill.exe /PID $ProcessId /T /F 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "taskkill failed for ClawBridge PID ${ProcessId}: $($taskkillOutput -join ' ')"
  }
  Start-Sleep -Milliseconds 500
  try {
    $remaining = @(Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop) | Select-Object -First 1
  } catch {
    $remainingNative = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if ($null -eq $remainingNative) {
      return
    }
    throw "Unable to verify that ClawBridge PID $ProcessId exited after taskkill; its PID record was retained: $($_.Exception.Message)"
  }
  if ($null -ne $remaining) {
    throw "ClawBridge process tree is still running after taskkill."
  }
}

function Remove-ClawBridgeShutdownRequest {
  param(
    [Parameter(Mandatory = $true)][string]$ShutdownFile,
    [Parameter(Mandatory = $true)][string]$Token
  )

  if (-not (Test-Path -LiteralPath $ShutdownFile -PathType Leaf)) {
    return
  }
  try {
    $request = Get-Content -Raw -Encoding UTF8 -LiteralPath $ShutdownFile | ConvertFrom-Json
    if ([string]$request.token -eq $Token) {
      Remove-Item -LiteralPath $ShutdownFile -Force
    }
  } catch {
    # Do not delete a request that cannot be proven to belong to this caller.
  }
}

function Test-ClawBridgeStopIntent {
  param(
    [Parameter(Mandatory = $true)][string]$StopIntentFile,
    [Parameter(Mandatory = $true)][int]$ProcessId
  )

  if (-not (Test-Path -LiteralPath $StopIntentFile -PathType Leaf)) {
    return $false
  }
  try {
    $intent = Get-Content -Raw -Encoding UTF8 -LiteralPath $StopIntentFile | ConvertFrom-Json
    return [int]$intent.version -eq 1 -and [int]$intent.pid -eq $ProcessId -and
      -not [string]::IsNullOrWhiteSpace([string]$intent.token)
  } catch {
    return $false
  }
}

function Remove-ClawBridgeStopIntent {
  param(
    [Parameter(Mandatory = $true)][string]$StopIntentFile,
    [int]$ExpectedPid = 0
  )

  if (-not (Test-Path -LiteralPath $StopIntentFile -PathType Leaf)) {
    return
  }
  if ($ExpectedPid -gt 0 -and -not (Test-ClawBridgeStopIntent -StopIntentFile $StopIntentFile -ProcessId $ExpectedPid)) {
    return
  }
  Remove-Item -LiteralPath $StopIntentFile -Force
}

function Restore-ClawBridgeProcessEnvironment {
  param([Parameter(Mandatory = $true)][hashtable]$Previous)

  foreach ($entry in $Previous.GetEnumerator()) {
    [Environment]::SetEnvironmentVariable([string]$entry.Key, $entry.Value, "Process")
  }
}

function Move-ClawBridgeLogToArchive {
  param([Parameter(Mandatory = $true)][string]$Path)

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    return
  }
  $archiveDirectory = Join-Path (Split-Path -Parent $Path) "archive"
  New-Item -ItemType Directory -Force -Path $archiveDirectory | Out-Null
  $timestamp = [DateTime]::Now.ToString("yyyyMMdd-HHmmss-fff")
  $fileName = [IO.Path]::GetFileNameWithoutExtension($Path)
  $extension = [IO.Path]::GetExtension($Path)
  Move-Item -LiteralPath $Path -Destination (Join-Path $archiveDirectory "$fileName.$timestamp$extension")
}

function Test-ClawBridgePathEqual {
  param(
    [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Left,
    [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Right
  )

  try {
    $leftPath = [IO.Path]::GetFullPath($Left).TrimEnd([char[]]@('\', '/'))
    $rightPath = [IO.Path]::GetFullPath($Right).TrimEnd([char[]]@('\', '/'))
    return [string]::Equals($leftPath, $rightPath, [StringComparison]::OrdinalIgnoreCase)
  } catch {
    return $false
  }
}

function Get-ClawBridgeExpectedTaskDefinition {
  param(
    [string]$ProjectRoot = (Get-ClawBridgeProjectRoot),
    [string]$CredentialPath = (Get-ClawBridgeCredentialPath),
    [switch]$Legacy
  )

  $requestedRootPath = [IO.Path]::GetFullPath($ProjectRoot)
  $manifest = Get-ClawBridgeAutostartRuntimeManifest -ProjectRoot $requestedRootPath
  $identityRootPath = if ($null -eq $manifest) { $requestedRootPath } else { $manifest.SourceRoot }
  $projectRootPath = if ($null -eq $manifest) { $requestedRootPath } else { $manifest.RuntimeRoot }
  $credentialFullPath = [IO.Path]::GetFullPath($CredentialPath)
  $powershellExecutable = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
  $startScript = Join-Path $projectRootPath "scripts\start.ps1"
  $argumentPrefix = "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$startScript`""
  $allowedArguments = @(
    "$argumentPrefix -Supervised -CredentialPath `"$credentialFullPath`""
  )
  if ($Legacy) {
    # The first supervised-task implementation used -Foreground. Accept that
    # exact historical form only for migration of the old generic task name.
    $allowedArguments += "$argumentPrefix -Foreground -CredentialPath `"$credentialFullPath`""
  }

  return [pscustomobject]@{
    TaskName = if ($Legacy) { $script:ClawBridgeTaskPrefix } else { Get-ClawBridgeTaskName -ProjectRoot $identityRootPath }
    TaskPath = "\"
    Execute = $powershellExecutable
    Arguments = $allowedArguments
    WorkingDirectory = $projectRootPath
    UserSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    UserName = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  }
}

function Test-ClawBridgeScheduledTaskOwned {
  param(
    [Parameter(Mandatory = $true)]$Task,
    [string]$ProjectRoot = (Get-ClawBridgeProjectRoot),
    [string]$CredentialPath = (Get-ClawBridgeCredentialPath),
    [switch]$Legacy
  )

  $expected = Get-ClawBridgeExpectedTaskDefinition -ProjectRoot $ProjectRoot -CredentialPath $CredentialPath -Legacy:$Legacy
  $reasons = New-Object System.Collections.Generic.List[string]
  if (-not [string]::Equals([string]$Task.TaskName, $expected.TaskName, [StringComparison]::OrdinalIgnoreCase)) {
    $reasons.Add("task name does not match")
  }
  if (-not [string]::Equals([string]$Task.TaskPath, $expected.TaskPath, [StringComparison]::OrdinalIgnoreCase)) {
    $reasons.Add("task path is not the root task folder")
  }

  $actions = @($Task.Actions)
  if ($actions.Count -ne 1) {
    $reasons.Add("expected exactly one action")
  } else {
    $action = $actions[0]
    if (-not (Test-ClawBridgePathEqual -Left ([string]$action.Execute) -Right $expected.Execute)) {
      $reasons.Add("action executable does not match Windows PowerShell")
    }
    $argumentMatches = $false
    foreach ($allowed in $expected.Arguments) {
      if ([string]::Equals(([string]$action.Arguments).Trim(), $allowed, [StringComparison]::OrdinalIgnoreCase)) {
        $argumentMatches = $true
        break
      }
    }
    if (-not $argumentMatches) {
      $reasons.Add("action arguments do not match this project's supervised start command")
    }
    if (-not (Test-ClawBridgePathEqual -Left ([string]$action.WorkingDirectory) -Right $expected.WorkingDirectory)) {
      $reasons.Add("action working directory does not match this project")
    }
  }

  if ($null -eq $Task.Principal) {
    $reasons.Add("task principal is missing")
  } else {
    $principalIdentity = [string]$Task.Principal.UserId
    $principalSid = ConvertTo-ClawBridgeSid -IdentityReference $principalIdentity
    if (-not [string]::Equals($principalSid, $expected.UserSid, [StringComparison]::OrdinalIgnoreCase) -and
        -not [string]::Equals($principalIdentity, $expected.UserName, [StringComparison]::OrdinalIgnoreCase)) {
      $reasons.Add("task principal is not the current Windows user")
    }
    $runLevel = [string]$Task.Principal.RunLevel
    if ($runLevel -notin @("Limited", "0")) {
      $reasons.Add("task run level is not Limited")
    }
    $logonType = [string]$Task.Principal.LogonType
    if ($logonType -notin @("Interactive", "InteractiveToken", "3")) {
      $reasons.Add("task logon type is not Interactive")
    }
  }

  return [pscustomobject]@{
    Owned = $reasons.Count -eq 0
    Reason = $reasons -join "; "
    Expected = $expected
  }
}

function Assert-ClawBridgeScheduledTaskOwned {
  param(
    [Parameter(Mandatory = $true)]$Task,
    [string]$ProjectRoot = (Get-ClawBridgeProjectRoot),
    [string]$CredentialPath = (Get-ClawBridgeCredentialPath),
    [switch]$Legacy
  )

  $ownership = Test-ClawBridgeScheduledTaskOwned -Task $Task -ProjectRoot $ProjectRoot -CredentialPath $CredentialPath -Legacy:$Legacy
  if (-not $ownership.Owned) {
    $kind = if ($Legacy) { "legacy" } else { "project-specific" }
    throw "A $kind scheduled task named '$($Task.TaskName)' exists but is not owned by this ClawBridge project. Refusing to start, stop, overwrite, or unregister it. Details: $($ownership.Reason)"
  }
  return $Task
}

function Get-ClawBridgeScheduledTaskByName {
  param([Parameter(Mandatory = $true)][string]$TaskName)

  # Restrict the query to the root task folder. A task with the same leaf name
  # in another folder is unrelated and must never be selected or modified.
  $matches = @(Get-ScheduledTask -TaskPath "\" -ErrorAction Stop | Where-Object {
      [string]::Equals([string]$_.TaskName, $TaskName, [StringComparison]::OrdinalIgnoreCase)
    })
  if ($matches.Count -gt 1) {
    throw "Multiple root scheduled tasks named '$TaskName' were returned; refusing to choose one."
  }
  return $matches | Select-Object -First 1
}

function Get-ClawBridgeAutostartRegistration {
  param(
    [string]$ProjectRoot = (Get-ClawBridgeProjectRoot),
    [string]$CredentialPath = (Get-ClawBridgeCredentialPath)
  )

  $manifest = Get-ClawBridgeAutostartRuntimeManifest -ProjectRoot $ProjectRoot
  $identityRoot = if ($null -eq $manifest) { $ProjectRoot } else { $manifest.SourceRoot }
  $taskName = Get-ClawBridgeTaskName -ProjectRoot $identityRoot
  $projectTask = Get-ClawBridgeScheduledTaskByName -TaskName $taskName
  if ($null -ne $projectTask) {
    Assert-ClawBridgeScheduledTaskOwned -Task $projectTask -ProjectRoot $ProjectRoot -CredentialPath $CredentialPath | Out-Null
  }
  $legacyTask = Get-ClawBridgeScheduledTaskByName -TaskName $script:ClawBridgeTaskPrefix
  if ($null -ne $legacyTask) {
    Assert-ClawBridgeScheduledTaskOwned -Task $legacyTask -ProjectRoot $ProjectRoot -CredentialPath $CredentialPath -Legacy | Out-Null
  }

  $selectedTask = if ($null -ne $projectTask) { $projectTask } else { $legacyTask }
  return [pscustomobject]@{
    Installed = $null -ne $selectedTask
    Task = $selectedTask
    TaskName = if ($null -eq $selectedTask) { $taskName } else { [string]$selectedTask.TaskName }
    ProjectTask = $projectTask
    LegacyTask = $legacyTask
    MigrationRequired = $null -ne $legacyTask
  }
}

function Test-ClawBridgeAutostartInstalled {
  param(
    [string]$ProjectRoot = (Get-ClawBridgeProjectRoot),
    [string]$CredentialPath = (Get-ClawBridgeCredentialPath)
  )

  return (Get-ClawBridgeAutostartRegistration -ProjectRoot $ProjectRoot -CredentialPath $CredentialPath).Installed
}

function ConvertTo-ClawBridgeSid {
  param([Parameter(Mandatory = $true)]$IdentityReference)

  try {
    if ($IdentityReference -is [Security.Principal.SecurityIdentifier]) {
      return $IdentityReference.Value
    }
    if ($IdentityReference -is [Security.Principal.IdentityReference]) {
      return $IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
    }
    $identityText = [string]$IdentityReference
    if ($identityText -match '^S-\d-(?:\d+-)+\d+$') {
      return $identityText
    }
    try {
      $account = New-Object Security.Principal.NTAccount -ArgumentList $identityText
      return $account.Translate([Security.Principal.SecurityIdentifier]).Value
    } catch {
      # Task Scheduler commonly normalizes a local principal from
      # MACHINE\User to the short form User. Resolve that form explicitly
      # against the local computer before treating it as untrusted.
      if ($identityText -notmatch '[\\@]' -and -not [string]::IsNullOrWhiteSpace($env:COMPUTERNAME)) {
        $localAccount = New-Object Security.Principal.NTAccount -ArgumentList $env:COMPUTERNAME, $identityText
        return $localAccount.Translate([Security.Principal.SecurityIdentifier]).Value
      }
      throw
    }
  } catch {
    return [string]$IdentityReference
  }
}

function Get-ClawBridgeUnsafeAclEntries {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][hashtable]$AllowedSids,
    [switch]$ReplacementRiskOnly
  )

  $problems = New-Object System.Collections.Generic.List[string]
  try {
    $acl = Get-Acl -LiteralPath $Path -ErrorAction Stop
  } catch {
    $problems.Add("$Path (ACL could not be read: $($_.Exception.Message))")
    return @($problems)
  }

  $ownerSid = ConvertTo-ClawBridgeSid -IdentityReference $acl.Owner
  if (-not $AllowedSids.ContainsKey($ownerSid)) {
    $problems.Add("$Path (untrusted owner: $($acl.Owner))")
  }

  $writeMask = if ($ReplacementRiskOnly) {
    [long]([Security.AccessControl.FileSystemRights]::Delete -bor
      [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
      [Security.AccessControl.FileSystemRights]::ChangePermissions -bor
      [Security.AccessControl.FileSystemRights]::TakeOwnership)
  } else {
    # Do not use the composite Write/Modify/FullControl enum values here.
    # They include Synchronize, which is also present on ordinary
    # ReadAndExecute ACEs and would falsely classify Program Files as writable.
    [long]([Security.AccessControl.FileSystemRights]::WriteData -bor
      [Security.AccessControl.FileSystemRights]::CreateFiles -bor
      [Security.AccessControl.FileSystemRights]::AppendData -bor
      [Security.AccessControl.FileSystemRights]::CreateDirectories -bor
      [Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor
      [Security.AccessControl.FileSystemRights]::WriteAttributes -bor
      [Security.AccessControl.FileSystemRights]::Delete -bor
      [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
      [Security.AccessControl.FileSystemRights]::ChangePermissions -bor
      [Security.AccessControl.FileSystemRights]::TakeOwnership)
  }
  foreach ($rule in $acl.Access) {
    if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) {
      continue
    }
    if (($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0) {
      continue
    }
    if (([long]$rule.FileSystemRights -band $writeMask) -eq 0) {
      continue
    }
    $sid = ConvertTo-ClawBridgeSid -IdentityReference $rule.IdentityReference
    if (-not $AllowedSids.ContainsKey($sid)) {
      $problems.Add("$Path (writable by $($rule.IdentityReference): $($rule.FileSystemRights))")
    }
  }
  return @($problems)
}

function Assert-ClawBridgeAutostartSecurity {
  param(
    [Parameter(Mandatory = $true)]$Paths,
    [string[]]$ExecutablePaths = @()
  )

  $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $allowedSids = @{
    $currentSid = $true
    "S-1-5-18" = $true
    "S-1-5-32-544" = $true
    # NT SERVICE\TrustedInstaller owns protected Windows ancestors such as the
    # system-drive root and is trusted not to replace this user's project.
    "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464" = $true
  }

  $requiredPaths = @(
    $Paths.ProjectRoot,
    (Join-Path $Paths.ProjectRoot "scripts"),
    (Join-Path $Paths.ProjectRoot "dist"),
    (Join-Path $Paths.ProjectRoot "node_modules"),
    (Join-Path $Paths.ProjectRoot "config"),
    (Join-Path $Paths.ProjectRoot "package.json")
  )
  foreach ($path in $requiredPaths) {
    if (-not (Test-Path -LiteralPath $path)) {
      throw "Autostart security check failed because a required runtime path is missing: $path"
    }
  }

  # A reparse-point project root or a replaceable ancestor can redirect the
  # fixed task action to different code after registration, even when every
  # current descendant has a restrictive ACL.
  $problems = @()
  $projectRootItem = Get-Item -LiteralPath $Paths.ProjectRoot -Force -ErrorAction Stop
  if (($projectRootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    $problems += "$($projectRootItem.FullName) (the project root is a reparse point)"
  }
  $problems += @(Get-ClawBridgeUnsafeAclEntries -Path $Paths.ProjectRoot -AllowedSids $allowedSids)
  $ancestor = Split-Path -Parent ([IO.Path]::GetFullPath($Paths.ProjectRoot))
  while (-not [string]::IsNullOrWhiteSpace($ancestor) -and $problems.Count -lt 20) {
    $ancestorItem = Get-Item -LiteralPath $ancestor -Force -ErrorAction Stop
    if (($ancestorItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      $problems += "$($ancestorItem.FullName) (an ancestor is a reparse point)"
    } else {
      $problems += @(Get-ClawBridgeUnsafeAclEntries -Path $ancestorItem.FullName -AllowedSids $allowedSids -ReplacementRiskOnly)
    }
    $nextAncestor = Split-Path -Parent $ancestorItem.FullName
    if ([string]::IsNullOrWhiteSpace($nextAncestor) -or [string]::Equals($nextAncestor, $ancestorItem.FullName, [StringComparison]::OrdinalIgnoreCase)) {
      break
    }
    $ancestor = $nextAncestor
  }

  # If the project root itself is writable by another principal, checking its
  # descendants cannot make the launch trustworthy because files can be replaced.
  if ($problems.Count -eq 0) {
    $criticalRoots = @(
      (Join-Path $Paths.ProjectRoot "scripts"),
      (Join-Path $Paths.ProjectRoot "dist"),
      (Join-Path $Paths.ProjectRoot "node_modules"),
      (Join-Path $Paths.ProjectRoot "config")
    )
    foreach ($optionalDirectory in @("data", "logs")) {
      $optionalPath = Join-Path $Paths.ProjectRoot $optionalDirectory
      if (Test-Path -LiteralPath $optionalPath -PathType Container) {
        $criticalRoots += $optionalPath
      }
    }
    $criticalFiles = @((Join-Path $Paths.ProjectRoot "package.json"))
    $lockFile = Join-Path $Paths.ProjectRoot "package-lock.json"
    if (Test-Path -LiteralPath $lockFile -PathType Leaf) {
      $criticalFiles += $lockFile
    }
    foreach ($root in $criticalRoots) {
      $items = @((Get-Item -LiteralPath $root -Force)) + @(Get-ChildItem -LiteralPath $root -Recurse -Force -ErrorAction Stop)
      foreach ($item in $items) {
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
          $problems += "$($item.FullName) (reparse points are not allowed in an autostart runtime tree)"
        } else {
          $problems += @(Get-ClawBridgeUnsafeAclEntries -Path $item.FullName -AllowedSids $allowedSids)
        }
        if ($problems.Count -ge 20) { break }
      }
      if ($problems.Count -ge 20) { break }
    }
    if ($problems.Count -lt 20) {
      foreach ($file in $criticalFiles) {
        $problems += @(Get-ClawBridgeUnsafeAclEntries -Path $file -AllowedSids $allowedSids)
        if ($problems.Count -ge 20) { break }
      }
    }
    if ($problems.Count -lt 20) {
      foreach ($executable in $ExecutablePaths) {
        if ([string]::IsNullOrWhiteSpace($executable) -or -not (Test-Path -LiteralPath $executable -PathType Leaf)) {
          $problems += "$executable (required executable is missing)"
          continue
        }
        $resolvedExecutable = (Resolve-Path -LiteralPath $executable).Path
        $problems += @(Get-ClawBridgeUnsafeAclEntries -Path $resolvedExecutable -AllowedSids $allowedSids)
        $parent = Split-Path -Parent $resolvedExecutable
        if (-not [string]::IsNullOrWhiteSpace($parent)) {
          $problems += @(Get-ClawBridgeUnsafeAclEntries -Path $parent -AllowedSids $allowedSids)
        }
        if ($problems.Count -ge 20) { break }
      }
    }
  }

  if ($problems.Count -gt 0) {
    $details = ($problems | Select-Object -First 20) -join [Environment]::NewLine
    throw "Autostart was refused because the runtime can be modified by an account other than the current user, SYSTEM, or Administrators. ClawBridge did not change any permissions. Move the project to a private directory or secure its ACL, then retry.`n$details"
  }
}
