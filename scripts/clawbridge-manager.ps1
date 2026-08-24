[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

[System.Windows.Forms.Application]::EnableVisualStyles()

$script:managerScriptRoot = if (-not [string]::IsNullOrWhiteSpace($env:CLAWBRIDGE_MANAGER_SCRIPT_ROOT)) {
  $env:CLAWBRIDGE_MANAGER_SCRIPT_ROOT
} else {
  $PSScriptRoot
}
$script:projectRoot = (Resolve-Path (Join-Path $script:managerScriptRoot "..")).Path
$script:commonScript = Join-Path $script:managerScriptRoot "lib\ClawBridge.Common.ps1"
if (-not (Test-Path -LiteralPath $script:commonScript -PathType Leaf)) {
  throw "ClawBridge common management library was not found."
}
. $script:commonScript
$script:credentialPath = Get-ClawBridgeCredentialPath
$script:statusTimer = $null
$script:updatingAutostart = $false
$script:secretValueForRedaction = ""
$script:secretPlaceholder = "************"
$script:secretPlaceholderActive = $false
$script:hasSavedSecret = $false
$script:activeManagedOperation = $null
$script:operationTimer = $null
$script:activeRefreshOperation = $null
$script:refreshPollTimer = $null
$script:refreshRequestVersion = 0
$script:pendingRefresh = $false
$script:pendingFullRefresh = $false
$script:pendingLogRefresh = $false
$script:lastStatusDiagnostic = ""

function Protect-DisplayText {
  param([AllowEmptyString()][string]$Text)

  if ([string]::IsNullOrEmpty($Text)) {
    return ""
  }

  $safe = $Text
  foreach ($value in @(
      $script:appIdBox.Text,
      $script:openIdBox.Text,
      $script:secretValueForRedaction
    )) {
    if (-not [string]::IsNullOrWhiteSpace($value)) {
      $safe = $safe.Replace($value, "***")
    }
  }

  # Redact structured log fields even when the current form is empty. This
  # covers compact and whitespace-heavy JSON without depending on known values.
  $safe = $safe -replace '(?i)(["'']?(?:app_secret|app_id|open_id)["'']?\s*:\s*)(?:"(?:\\.|[^"\\])*"|''(?:\\.|[^''\\])*''|[^,\s}\]]+)', '$1"***"'
  $safe = $safe -replace '(?i)(CLAWBRIDGE_FEISHU_(?:APP_ID|APP_SECRET|ALLOWED_OPEN_ID)\s*[=:]\s*)\S+', '$1***'
  $safe = $safe -replace '(?i)((?:app[ _-]?id|app[ _-]?secret|open[ _-]?id)\s*[=:]\s*)\S+', '$1***'
  $safe = $safe -replace '\bcli_[A-Za-z0-9_-]+\b', '***'
  $safe = $safe -replace '\bou_[A-Za-z0-9_-]+\b', '***'
  return $safe
}

function Write-ManagerLog {
  param(
    [Parameter(Mandatory = $true)][string]$Message,
    [switch]$Replace
  )

  $safeMessage = Protect-DisplayText $Message
  if ($Replace) {
    $script:logBox.Text = $safeMessage
  } else {
    $timestamp = Get-Date -Format "HH:mm:ss"
    if ($script:logBox.TextLength -gt 0) {
      $script:logBox.AppendText([Environment]::NewLine)
    }
    $script:logBox.AppendText("[$timestamp] $safeMessage")
  }
  $script:logBox.SelectionStart = $script:logBox.TextLength
  $script:logBox.ScrollToCaret()
}

function Show-ManagerError {
  param(
    [Parameter(Mandatory = $true)][string]$Title,
    [Parameter(Mandatory = $true)][string]$Message
  )

  $safeMessage = Protect-DisplayText $Message
  Write-ManagerLog "$Title：$safeMessage"
  [System.Windows.Forms.MessageBox]::Show(
    $script:form,
    $safeMessage,
    $Title,
    [System.Windows.Forms.MessageBoxButtons]::OK,
    [System.Windows.Forms.MessageBoxIcon]::Error
  ) | Out-Null
}

function Start-ManagedScriptProcess {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [string]$ArgumentText = ""
  )

  $scriptPath = Join-Path $script:managerScriptRoot $Name
  if (-not (Test-Path -LiteralPath $scriptPath)) {
    throw "缺少管理脚本：$Name"
  }

  $resultPath = Join-Path ([IO.Path]::GetTempPath()) ("clawbridge-manager-{0}.json" -f [Guid]::NewGuid().ToString("N"))
  $escapedPath = $scriptPath.Replace("'", "''")
  $escapedResultPath = $resultPath.Replace("'", "''")
  $command = @"
`$ErrorActionPreference = "Continue"
`$capturedOutput = @()
`$capturedErrors = @()
`$exitCode = 0
try {
  `$capturedOutput = @(& '$escapedPath' $ArgumentText -ErrorVariable +capturedErrors)
  if (-not `$?) {
    `$exitCode = 1
  }
} catch {
  `$capturedErrors += `$_
  `$exitCode = 1
}
try {
  `$payload = [ordered]@{
    version = 1
    exitCode = `$exitCode
    output = ((`$capturedOutput | Out-String -Width 4096).Trim())
    error = ((`$capturedErrors | Out-String -Width 4096).Trim())
  }
  `$json = `$payload | ConvertTo-Json -Compress
  [IO.File]::WriteAllText('$escapedResultPath', `$json, (New-Object Text.UTF8Encoding(`$false)))
} catch {
  exit 254
}
exit `$exitCode
"@
  $encodedCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))

  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
  $startInfo.Arguments = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand $encodedCommand"
  $startInfo.WorkingDirectory = $script:projectRoot
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
  $startInfo.RedirectStandardOutput = $false
  $startInfo.RedirectStandardError = $false

  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $startInfo
  try {
    if (-not $process.Start()) {
      throw "无法启动 PowerShell 子进程。"
    }
    return [PSCustomObject]@{
      Name       = $Name
      Process    = $process
      ResultPath = $resultPath
    }
  } catch {
    $process.Dispose()
    Remove-Item -LiteralPath $resultPath -Force -ErrorAction SilentlyContinue
    throw
  }
}

function Read-ManagedScriptResult {
  param(
    [Parameter(Mandatory = $true)][string]$ResultPath,
    [Parameter(Mandatory = $true)][int]$ProcessExitCode
  )

  if (-not (Test-Path -LiteralPath $ResultPath -PathType Leaf)) {
    throw "管理脚本未生成结果文件（PowerShell 退出码 $ProcessExitCode）。"
  }
  $resultItem = Get-Item -LiteralPath $ResultPath
  if ($resultItem.Length -gt 16777216) {
    throw "管理脚本结果文件异常过大，已拒绝读取。"
  }
  try {
    $payload = Get-Content -LiteralPath $ResultPath -Raw -Encoding UTF8 | ConvertFrom-Json
  } catch {
    throw "管理脚本结果文件无法解析：$($_.Exception.Message)"
  }
  $payloadExitCode = 0
  if ($payload.version -ne 1 -or -not [int]::TryParse([string]$payload.exitCode, [ref]$payloadExitCode)) {
    throw "管理脚本结果文件格式不受支持。"
  }
  if ($payloadExitCode -ne $ProcessExitCode) {
    throw "管理脚本结果退出码不一致（进程 $ProcessExitCode，结果 $payloadExitCode）。"
  }
  return [PSCustomObject]@{
    ExitCode = $payloadExitCode
    Output = ([string]$payload.output).Trim()
    Error = ([string]$payload.error).Trim()
  }
}

function Get-ManagedProcessTreeSnapshot {
  param([Parameter(Mandatory = $true)][int]$RootProcessId)

  $allProcesses = @(Get-CimInstance Win32_Process -ErrorAction Stop | Select-Object ProcessId, ParentProcessId)
  $tree = @($RootProcessId)
  do {
    $added = $false
    foreach ($candidate in $allProcesses) {
      $candidateId = [int]$candidate.ProcessId
      $parentId = [int]$candidate.ParentProcessId
      if ($tree -contains $parentId -and $tree -notcontains $candidateId) {
        $tree += $candidateId
        $added = $true
      }
    }
  } while ($added)
  return @($tree)
}

function Stop-ManagedScriptProcessTree {
  param([Parameter(Mandatory = $true)][Diagnostics.Process]$Process)

  $treePids = @($Process.Id)
  $snapshotError = ""
  try {
    $treePids = @(Get-ManagedProcessTreeSnapshot -RootProcessId $Process.Id)
  } catch {
    $snapshotError = $_.Exception.Message
  }

  $taskkillOutput = & taskkill.exe /PID $Process.Id /T /F 2>&1
  $taskkillExitCode = $LASTEXITCODE
  try {
    [void]$Process.WaitForExit(5000)
  } catch {
    # Verify below using both the Process object and the captured tree PIDs.
  }

  $remainingPids = @()
  foreach ($candidateId in $treePids) {
    if ($null -ne (Get-Process -Id $candidateId -ErrorAction SilentlyContinue)) {
      $remainingPids += $candidateId
    }
  }
  $rootStillRunning = $false
  try {
    $Process.Refresh()
    $rootStillRunning = -not $Process.HasExited
  } catch {
    $rootStillRunning = $false
  }
  if ($rootStillRunning -or $remainingPids.Count -gt 0) {
    $detail = (($taskkillOutput | Out-String).Trim())
    throw "taskkill /T /F 后仍检测到进程：$($remainingPids -join ', ')。退出码：$taskkillExitCode。$detail"
  }
  if (-not [string]::IsNullOrWhiteSpace($snapshotError)) {
    return "进程树已由 taskkill /T /F 终止；终止前无法枚举全部子进程：$snapshotError"
  }
  return "进程树已由 taskkill /T /F 终止并验证。"
}

function Remove-ManagedScriptResult {
  param([AllowEmptyString()][string]$ResultPath)

  if (-not [string]::IsNullOrWhiteSpace($ResultPath)) {
    Remove-Item -LiteralPath $ResultPath -Force -ErrorAction SilentlyContinue
  }
}

function Invoke-ManagedScript {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [string]$ArgumentText = "",
    [ValidateRange(1, 1800)][int]$TimeoutSeconds = 60
  )

  $operation = Start-ManagedScriptProcess -Name $Name -ArgumentText $ArgumentText
  $process = $operation.Process
  try {
    $timeoutMilliseconds = [int]($TimeoutSeconds * 1000)
    if (-not $process.WaitForExit($timeoutMilliseconds)) {
      try {
        $cleanupDetail = Stop-ManagedScriptProcessTree -Process $process
      } catch {
        $cleanupDetail = "进程树清理验证失败：$($_.Exception.Message)"
      }
      throw "管理脚本 $Name 超过 $TimeoutSeconds 秒。$cleanupDetail"
    }

    $process.WaitForExit()
    return Read-ManagedScriptResult -ResultPath $operation.ResultPath -ProcessExitCode $process.ExitCode
  } finally {
    $process.Dispose()
    Remove-ManagedScriptResult -ResultPath $operation.ResultPath
  }
}

function Start-ManagedScriptOperation {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [string]$ArgumentText = "",
    [ValidateRange(1, 1800)][int]$TimeoutSeconds = 60,
    [Parameter(Mandatory = $true)][ValidateSet("Service", "Autostart")][string]$Kind,
    [Parameter(Mandatory = $true)][hashtable]$Context
  )

  if ($null -ne $script:activeManagedOperation) {
    throw "已有管理操作正在执行，请等待完成。"
  }

  $child = Start-ManagedScriptProcess -Name $Name -ArgumentText $ArgumentText
  $script:activeManagedOperation = [PSCustomObject]@{
    Kind           = $Kind
    Context        = $Context
    Name           = $Name
    Process        = $child.Process
    ResultPath     = $child.ResultPath
    Deadline       = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  }
  $script:operationTimer.Start()
}

function Complete-ManagedScriptOperation {
  param(
    $Result,
    [AllowEmptyString()][string]$FailureMessage = ""
  )

  $operation = $script:activeManagedOperation
  $script:activeManagedOperation = $null
  $script:operationTimer.Stop()
  try {
    if (-not [string]::IsNullOrWhiteSpace($FailureMessage)) {
      throw $FailureMessage
    }

    $combined = @($Result.Output, $Result.Error) -join [Environment]::NewLine
    if ($Result.ExitCode -ne 0) {
      $detail = $combined.Trim()
      if ([string]::IsNullOrWhiteSpace($detail)) {
        $detail = "管理脚本 $($operation.Name) 失败，退出码 $($Result.ExitCode)。"
      }
      throw $detail
    }

    if (-not [string]::IsNullOrWhiteSpace($combined)) {
      Write-ManagerLog $combined.Trim()
    }
    if ($operation.Kind -eq "Service") {
      Write-ManagerLog "$($operation.Context.DisplayName)操作完成。"
    } else {
      Write-ManagerLog "登录自启动设置已更新。"
    }
  } catch {
    $message = $_.Exception.Message
    if ($operation.Kind -eq "Autostart" -and $message -match '(?i)Autostart was refused|writable by|untrusted owner') {
      $message = "安全检查发现当前项目目录可被其他本机账户修改，因此没有启用登录自启动，也没有更改任何目录权限。请把项目移到当前用户私有目录，或在确认影响后单独收紧该目录的 ACL。`r`n`r`n详细信息：`r`n$message"
    }
    $title = if ($operation.Kind -eq "Service") { "$($operation.Context.DisplayName)失败" } else { "自启动设置失败" }
    Show-ManagerError $title $message
  } finally {
    if ($null -ne $operation -and $null -ne $operation.Process) {
      $operation.Process.Dispose()
    }
    if ($null -ne $operation) {
      Remove-ManagedScriptResult -ResultPath $operation.ResultPath
    }
    $script:operationLabel.Text = "就绪"
    Set-ControlsEnabled $true
    Request-ManagerRefresh -Full -IncludeLogs
  }
}

function Update-ManagedScriptOperation {
  $operation = $script:activeManagedOperation
  if ($null -eq $operation) {
    $script:operationTimer.Stop()
    return
  }

  $process = $operation.Process
  if (-not $process.HasExited) {
    if ([DateTime]::UtcNow -ge $operation.Deadline) {
      try {
        $cleanupDetail = Stop-ManagedScriptProcessTree -Process $process
      } catch {
        $cleanupDetail = "进程树清理验证失败：$($_.Exception.Message)"
      }
      Complete-ManagedScriptOperation -Result $null -FailureMessage "管理脚本 $($operation.Name) 执行超时。$cleanupDetail"
    }
    return
  }

  try {
    $process.WaitForExit()
    $result = Read-ManagedScriptResult -ResultPath $operation.ResultPath -ProcessExitCode $process.ExitCode
    Complete-ManagedScriptOperation -Result $result
  } catch {
    Complete-ManagedScriptOperation -Result $null -FailureMessage $_.Exception.Message
  }
}

function Get-AutostartArgumentText {
  param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("Install", "Uninstall", "Status")]
    [string]$Mode
  )

  $scriptPath = Join-Path $script:managerScriptRoot "autostart.ps1"
  if (-not (Test-Path -LiteralPath $scriptPath)) {
    throw "缺少管理脚本：autostart.ps1"
  }
  $parameters = (Get-Command -Name $scriptPath -ErrorAction Stop).Parameters
  if ($parameters.ContainsKey("Action")) {
    return "-Action $Mode -Json"
  }
  switch ($Mode) {
    "Install" { return "-Enable -Json" }
    "Uninstall" { return "-Disable -Json" }
    default { return "-Status -Json" }
  }
}

function Set-ControlsEnabled {
  param([bool]$Enabled)

  foreach ($control in @(
      $script:saveButton,
      $script:saveStartButton,
      $script:startButton,
      $script:stopButton,
      $script:restartButton,
      $script:buildRestartButton,
      $script:refreshButton,
      $script:applyAutostartButton
  )) {
    $control.Enabled = $Enabled
  }
  if ($Enabled -and $null -ne $script:activeRefreshOperation) {
    $script:refreshButton.Enabled = $false
  }
}

function Set-SavedSecretPlaceholder {
  if ($script:hasSavedSecret) {
    $script:secretPlaceholderActive = $true
    $script:secretBox.Text = $script:secretPlaceholder
  } else {
    $script:secretPlaceholderActive = $false
    $script:secretBox.Clear()
  }
}

function Load-SavedCredentialFields {
  if (-not (Test-Path -LiteralPath $script:credentialPath -PathType Leaf)) {
    $script:hasSavedSecret = $false
    Set-SavedSecretPlaceholder
    return
  }

  try {
    $summary = Read-ClawBridgeCredentialSummary -CredentialPath $script:credentialPath
    $script:appIdBox.Text = [string]$summary.AppId
    $script:openIdBox.Text = [string]$summary.OpenId
    $script:hasSavedSecret = [bool]$summary.HasSecret
    Set-SavedSecretPlaceholder
    $script:credentialHint.Text = "✓ 已载入保存的凭据；App Secret 以固定占位显示，留空会继续使用原值。"
    $script:credentialHint.ForeColor = [Drawing.Color]::FromArgb(31, 122, 72)
  } catch {
    $script:hasSavedSecret = $false
    Set-SavedSecretPlaceholder
    $script:credentialHint.Text = "已找到凭据文件，但当前 Windows 用户无法读取；请重新填写三项。"
    $script:credentialHint.ForeColor = [Drawing.Color]::DarkOrange
    Write-ManagerLog "读取已保存凭据失败：$($_.Exception.Message)"
  }
}

function Save-Credentials {
  $appId = $script:appIdBox.Text.Trim()
  $openId = $script:openIdBox.Text.Trim()
  $preserveExistingSecret = $script:hasSavedSecret -and
    ($script:secretPlaceholderActive -or [string]::IsNullOrWhiteSpace($script:secretBox.Text))
  $appSecret = if ($script:secretPlaceholderActive) { "" } else { $script:secretBox.Text }

  if ([string]::IsNullOrWhiteSpace($appId) -or
      [string]::IsNullOrWhiteSpace($openId) -or
      (-not $preserveExistingSecret -and [string]::IsNullOrWhiteSpace($appSecret))) {
    Show-ManagerError "配置不完整" "请填写 App ID、App Secret 和 Open ID。"
    return $false
  }
  if ($appId -notmatch '^cli_[0-9a-fA-F]{16}$') {
    Show-ManagerError "App ID 格式不正确" "App ID 应为 cli_ 加 16 位十六进制字符，请从飞书开放平台复制后重试。"
    return $false
  }

  $configureScript = Join-Path $script:managerScriptRoot "configure-credentials.ps1"
  if (-not (Test-Path -LiteralPath $configureScript)) {
    Show-ManagerError "缺少配置组件" "找不到 scripts\configure-credentials.ps1。"
    return $false
  }

  $secureSecret = $null
  if (-not $preserveExistingSecret) {
    $script:secretValueForRedaction = $appSecret
    $secureSecret = ConvertTo-SecureString -String $appSecret -AsPlainText -Force
  }
  try {
    # Intentionally invoke in this process. The secret is never placed in a
    # child-process command line, console output, or repository file.
    $configureParameters = (Get-Command -Name $configureScript -ErrorAction Stop).Parameters
    $arguments = @{
      AppId = $appId
      CredentialPath = $script:credentialPath
    }
    if ($configureParameters.ContainsKey("AllowedOpenId")) {
      $arguments.AllowedOpenId = $openId
    } else {
      $arguments.OpenId = $openId
    }
    if ($preserveExistingSecret) {
      if (-not $configureParameters.ContainsKey("PreserveExistingSecret")) {
        throw "配置组件不支持保留已保存的 App Secret。"
      }
      $arguments.PreserveExistingSecret = $true
    } else {
      $arguments.AppSecret = $secureSecret
    }
    $result = & $configureScript @arguments 2>&1
    if ($result) {
      $sanitized = Protect-DisplayText (($result | Out-String).Trim())
      if (-not [string]::IsNullOrWhiteSpace($sanitized)) {
        Write-ManagerLog $sanitized
      }
    }
    $script:hasSavedSecret = $true
    Set-SavedSecretPlaceholder
    $script:credentialHint.Text = "✓ 凭据已使用当前 Windows 用户加密保存；App Secret 以固定占位显示。"
    $script:credentialHint.ForeColor = [Drawing.Color]::FromArgb(31, 122, 72)
    Write-ManagerLog "三项凭据已安全保存。"
    return $true
  } catch {
    Show-ManagerError "保存失败" $_.Exception.Message
    return $false
  } finally {
    if ($null -ne $secureSecret) {
      $secureSecret.Dispose()
    }
    $appSecret = $null
    $script:secretValueForRedaction = ""
  }
}

function Write-StatusDiagnosticOnce {
  param([AllowEmptyString()][string]$Message)

  if ([string]::IsNullOrWhiteSpace($Message)) {
    $script:lastStatusDiagnostic = ""
    return
  }
  if ($script:lastStatusDiagnostic -ne $Message) {
    $script:lastStatusDiagnostic = $Message
    Write-ManagerLog $Message
  }
}

function Set-BridgeStatusFromResult {
  param(
    $Result,
    [AllowEmptyString()][string]$FailureMessage = ""
  )

  try {
    if (-not [string]::IsNullOrWhiteSpace($FailureMessage)) {
      throw $FailureMessage
    }
    if ($null -eq $Result) {
      throw "status.ps1 未返回结果。"
    }
    if ($result.ExitCode -ne 0) {
      $detail = @($result.Output, $result.Error) -join [Environment]::NewLine
      if ([string]::IsNullOrWhiteSpace($detail)) {
        $detail = "status.ps1 退出码为 $($result.ExitCode)。"
      }
      throw $detail.Trim()
    }
    if ([string]::IsNullOrWhiteSpace($result.Output)) {
      throw "status.ps1 未返回状态数据。"
    }

    $running = $false
    $healthy = $false
    $state = "stopped"
    $pidText = ""
    $startupBlocked = $false
    $credentialsConfigured = $false

    try {
      $status = $result.Output | ConvertFrom-Json
    } catch {
      throw "status.ps1 返回了无法解析的状态数据：$($_.Exception.Message)"
    }
    if ($null -ne $status.running) {
      $running = [bool]$status.running
    } elseif ($status.status -eq "running") {
      $running = $true
    }
    if ($null -ne $status.healthy) {
      $healthy = [bool]$status.healthy
    }
    if (-not [string]::IsNullOrWhiteSpace([string]$status.state)) {
      $state = [string]$status.state
    }
    if ($null -ne $status.pid) {
      $pidText = "  PID $($status.pid)"
    }
    if ($null -ne $status.startupBlocked) {
      $startupBlocked = [bool]$status.startupBlocked
    }
    if ($null -ne $status.credentialsConfigured) {
      $credentialsConfigured = [bool]$status.credentialsConfigured
    }

    if ($credentialsConfigured) {
      $script:credentialHint.Text = '✓ 凭据已加密保存，可直接点击“启动”；重新填写三项可更新。'
      $script:credentialHint.ForeColor = [Drawing.Color]::FromArgb(31, 122, 72)
    } else {
      $script:credentialHint.Text = "尚未保存凭据，请填写 App ID、App Secret 和 Open ID。"
      $script:credentialHint.ForeColor = [Drawing.Color]::DarkOrange
    }

    # A running managed Bridge deliberately blocks a *second* start.  Running
    # health therefore takes precedence over startupBlocked, which is only a
    # user-facing conflict when no managed instance is running.
    if ($running -and $healthy) {
      $script:serviceStatusLabel.Text = "● 已连接$pidText"
      $script:serviceStatusLabel.ForeColor = [Drawing.Color]::FromArgb(31, 122, 72)
      Write-StatusDiagnosticOnce ""
    } elseif ($running -and $state -eq "starting") {
      $script:serviceStatusLabel.Text = "● 正在连接飞书$pidText"
      $script:serviceStatusLabel.ForeColor = [Drawing.Color]::DarkOrange
      Write-StatusDiagnosticOnce ""
    } elseif ($running) {
      $script:serviceStatusLabel.Text = "● 连接异常$pidText（查看错误日志）"
      $script:serviceStatusLabel.ForeColor = [Drawing.Color]::FromArgb(183, 28, 28)
      Write-StatusDiagnosticOnce ""
    } elseif ($startupBlocked) {
      $script:serviceStatusLabel.Text = "● 启动受阻$pidText（请关闭旧 npm/node 进程）"
      $script:serviceStatusLabel.ForeColor = [Drawing.Color]::FromArgb(183, 28, 28)
      if ($state -eq "unmanaged-ambiguous") {
        Write-StatusDiagnosticOnce "启动受阻：检测到旧 npm start/node dist/src/app.js 进程$pidText。请回到旧 PowerShell 窗口按 Ctrl+C 关闭，再点击“启动”。"
      } else {
        Write-StatusDiagnosticOnce "启动受阻：检测到冲突的 ClawBridge 进程$pidText。请先停止旧进程，再重试。"
      }
    } else {
      $script:serviceStatusLabel.Text = "● 已停止"
      $script:serviceStatusLabel.ForeColor = [Drawing.Color]::FromArgb(183, 28, 28)
      Write-StatusDiagnosticOnce ""
    }
  } catch {
    $script:serviceStatusLabel.Text = "● 状态检查失败（查看日志）"
    $script:serviceStatusLabel.ForeColor = [Drawing.Color]::FromArgb(183, 28, 28)
    Write-StatusDiagnosticOnce "状态检查失败：$($_.Exception.Message)"
  }
}

function Set-AutostartStatusFromResult {
  param(
    $Result,
    [AllowEmptyString()][string]$FailureMessage = "",
    [switch]$ScriptMissing
  )

  if ($ScriptMissing) {
    $script:autostartHint.Text = "自启动管理脚本尚未安装。"
    $script:applyAutostartButton.Enabled = $false
    return
  }

  try {
    if (-not [string]::IsNullOrWhiteSpace($FailureMessage)) {
      throw $FailureMessage
    }
    if ($null -eq $Result) {
      throw "autostart.ps1 未返回结果。"
    }
    if ($Result.ExitCode -ne 0) {
      $detail = @($Result.Output, $Result.Error) -join [Environment]::NewLine
      if ([string]::IsNullOrWhiteSpace($detail)) {
        $detail = "autostart.ps1 退出码为 $($Result.ExitCode)。"
      }
      throw $detail.Trim()
    }
    $installed = $false
    if (-not [string]::IsNullOrWhiteSpace($result.Output)) {
      try {
        $status = $result.Output | ConvertFrom-Json
        if ($null -ne $status.installed) {
          $installed = [bool]$status.installed
        } elseif ($status.status -eq "installed") {
          $installed = $true
        }
      } catch {
        $installed = ($result.ExitCode -eq 0 -and $result.Output -match '(?i)installed|enabled|registered')
      }
    }
    $script:updatingAutostart = $true
    $script:autostartCheckBox.Checked = $installed
    if ($installed) {
      $script:autostartHint.Text = "已启用：登录当前 Windows 用户后自动启动。"
    } else {
      $script:autostartHint.Text = "未启用；当前目录权限不安全时会拒绝启用。"
    }
  } catch {
    $script:autostartHint.Text = "无法读取自启动状态。"
  } finally {
    $script:updatingAutostart = $false
  }
}

function Get-LogSummary {
  $lines = New-Object System.Collections.Generic.List[string]
  foreach ($item in @(
      @{ Label = "运行日志"; Path = (Join-Path $script:projectRoot "logs\clawbridge.out.log") },
      @{ Label = "错误日志"; Path = (Join-Path $script:projectRoot "logs\clawbridge.err.log") }
    )) {
    if (Test-Path -LiteralPath $item.Path) {
      $content = @(Get-Content -LiteralPath $item.Path -Encoding UTF8 -Tail 30 -ErrorAction SilentlyContinue)
      if ($content.Count -gt 0) {
        $lines.Add("--- $($item.Label) ---")
        foreach ($line in $content) {
          $lines.Add((Protect-DisplayText ([string]$line)))
        }
      }
    }
  }

  if ($lines.Count -eq 0) {
    Write-ManagerLog "暂无日志。启动 ClawBridge 后会在这里显示最近记录。" -Replace
  } else {
    Write-ManagerLog ($lines -join [Environment]::NewLine) -Replace
  }
}

function New-ManagerRefreshJob {
  param(
    [Parameter(Mandatory = $true)][ValidateSet("Status", "Autostart", "AutostartMissing")][string]$Kind,
    [AllowEmptyString()][string]$Name = "",
    [AllowEmptyString()][string]$ArgumentText = "",
    [ValidateRange(1, 120)][int]$TimeoutSeconds = 10
  )

  if ($Kind -eq "AutostartMissing") {
    return [PSCustomObject]@{
      Kind       = $Kind
      Process    = $null
      ResultPath = ""
      Deadline   = [DateTime]::UtcNow
      Completed  = $false
      Failure    = ""
    }
  }

  try {
    $child = Start-ManagedScriptProcess -Name $Name -ArgumentText $ArgumentText
    return [PSCustomObject]@{
      Kind       = $Kind
      Process    = $child.Process
      ResultPath = $child.ResultPath
      Deadline   = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
      Completed  = $false
      Failure    = ""
    }
  } catch {
    return [PSCustomObject]@{
      Kind       = $Kind
      Process    = $null
      ResultPath = ""
      Deadline   = [DateTime]::UtcNow
      Completed  = $false
      Failure    = $_.Exception.Message
    }
  }
}

function Complete-ManagerRefreshJob {
  param(
    [Parameter(Mandatory = $true)]$Operation,
    [Parameter(Mandatory = $true)]$Job,
    $Result,
    [AllowEmptyString()][string]$FailureMessage = ""
  )

  $Job.Completed = $true
  $isCurrent = $Operation.Version -eq $script:refreshRequestVersion
  try {
    if ($isCurrent) {
      switch ($Job.Kind) {
        "Status" {
          Set-BridgeStatusFromResult -Result $Result -FailureMessage $FailureMessage
        }
        "Autostart" {
          Set-AutostartStatusFromResult -Result $Result -FailureMessage $FailureMessage
        }
        "AutostartMissing" {
          Set-AutostartStatusFromResult -Result $null -ScriptMissing
        }
      }
    }
  } finally {
    if ($null -ne $Job.Process) {
      $Job.Process.Dispose()
      $Job.Process = $null
    }
    Remove-ManagedScriptResult -ResultPath $Job.ResultPath
  }
}

function Start-PendingManagerRefresh {
  if (-not $script:pendingRefresh -or
      $null -ne $script:activeRefreshOperation -or
      $null -ne $script:activeManagedOperation) {
    return
  }

  $fullRefresh = $script:pendingFullRefresh
  $includeLogs = $script:pendingLogRefresh
  $script:pendingRefresh = $false
  $script:pendingFullRefresh = $false
  $script:pendingLogRefresh = $false

  if ($includeLogs) {
    Get-LogSummary
    # Get-LogSummary replaces the visible log text, so allow the current status
    # diagnostic to be appended again after that replacement.
    $script:lastStatusDiagnostic = ""
  }

  $jobs = New-Object System.Collections.Generic.List[object]
  $jobs.Add((New-ManagerRefreshJob -Kind Status -Name "status.ps1" -ArgumentText "-Json" -TimeoutSeconds 8))
  if ($fullRefresh) {
    $autostartScript = Join-Path $script:managerScriptRoot "autostart.ps1"
    if (Test-Path -LiteralPath $autostartScript -PathType Leaf) {
      try {
        $argumentText = Get-AutostartArgumentText -Mode Status
        $jobs.Add((New-ManagerRefreshJob -Kind Autostart -Name "autostart.ps1" -ArgumentText $argumentText -TimeoutSeconds 20))
      } catch {
        $jobs.Add([PSCustomObject]@{
            Kind       = "Autostart"
            Process    = $null
            ResultPath = ""
            Deadline   = [DateTime]::UtcNow
            Completed  = $false
            Failure    = $_.Exception.Message
          })
      }
    } else {
      $jobs.Add((New-ManagerRefreshJob -Kind AutostartMissing))
    }
  }

  $script:activeRefreshOperation = [PSCustomObject]@{
    Version   = $script:refreshRequestVersion
    Full      = $fullRefresh
    Jobs      = $jobs
    StartedAt = [DateTime]::UtcNow
  }
  $script:refreshButton.Text = "刷新中…"
  $script:refreshButton.Enabled = $false
  $script:refreshPollTimer.Start()
}

function Request-ManagerRefresh {
  param(
    [switch]$Full,
    [switch]$IncludeLogs
  )

  $script:refreshRequestVersion++
  $script:pendingRefresh = $true
  $script:pendingFullRefresh = $script:pendingFullRefresh -or [bool]$Full
  $script:pendingLogRefresh = $script:pendingLogRefresh -or [bool]$IncludeLogs
  Start-PendingManagerRefresh
}

function Invalidate-ManagerRefresh {
  # A service/autostart mutation makes any in-flight status snapshot stale.
  # Its child process is allowed to finish naturally, but its result is ignored.
  $script:refreshRequestVersion++
  $script:pendingRefresh = $false
  $script:pendingFullRefresh = $false
  $script:pendingLogRefresh = $false
}

function Update-ManagerRefresh {
  $operation = $script:activeRefreshOperation
  if ($null -eq $operation) {
    $script:refreshPollTimer.Stop()
    Start-PendingManagerRefresh
    return
  }

  $allCompleted = $true
  foreach ($job in $operation.Jobs) {
    if ($job.Completed) { continue }

    if ($job.Kind -eq "AutostartMissing") {
      Complete-ManagerRefreshJob -Operation $operation -Job $job -Result $null
      continue
    }
    if (-not [string]::IsNullOrWhiteSpace($job.Failure)) {
      Complete-ManagerRefreshJob -Operation $operation -Job $job -Result $null -FailureMessage $job.Failure
      continue
    }

    $process = $job.Process
    if ($null -eq $process) {
      Complete-ManagerRefreshJob -Operation $operation -Job $job -Result $null -FailureMessage "刷新子进程未成功启动。"
      continue
    }
    if (-not $process.HasExited) {
      if ([DateTime]::UtcNow -lt $job.Deadline) {
        $allCompleted = $false
        continue
      }
      try { $process.Kill() } catch {}
      Complete-ManagerRefreshJob `
        -Operation $operation `
        -Job $job `
        -Result $null `
        -FailureMessage "$($job.Kind) 状态检查超时；已终止该次检查，界面仍可继续使用。"
      continue
    }

    try {
      # HasExited is checked above.  In particular, refresh never calls
      # WaitForExit on the WinForms thread.
      $result = Read-ManagedScriptResult -ResultPath $job.ResultPath -ProcessExitCode $process.ExitCode
      Complete-ManagerRefreshJob -Operation $operation -Job $job -Result $result
    } catch {
      Complete-ManagerRefreshJob -Operation $operation -Job $job -Result $null -FailureMessage $_.Exception.Message
    }
  }

  foreach ($job in $operation.Jobs) {
    if (-not $job.Completed) {
      $allCompleted = $false
      break
    }
  }
  if (-not $allCompleted) { return }

  $isCurrent = $operation.Version -eq $script:refreshRequestVersion
  $script:activeRefreshOperation = $null
  $script:refreshPollTimer.Stop()
  $script:refreshButton.Text = "刷新状态"
  $script:refreshButton.Enabled = $null -eq $script:activeManagedOperation
  if ($isCurrent) {
    $script:lastRefreshLabel.Text = "最后刷新：$(Get-Date -Format 'HH:mm:ss')"
  }
  Start-PendingManagerRefresh
}

function Invoke-ServiceAction {
  param(
    [Parameter(Mandatory = $true)][ValidateSet("Start", "Stop", "Restart", "BuildRestart")][string]$Action
  )

  $scriptName = switch ($Action) {
    "Start" { "start.ps1" }
    "Stop" { "stop.ps1" }
    default { "restart.ps1" }
  }
  $argumentText = if ($Action -eq "BuildRestart") { "-Build" } else { "" }
  $displayName = switch ($Action) {
    "Start" { "启动" }
    "Stop" { "停止" }
    "Restart" { "重启" }
    default { "重新构建并重启" }
  }

  Invalidate-ManagerRefresh
  Set-ControlsEnabled $false
  $script:operationLabel.Text = "正在$displayName，请稍候……"
  try {
    $timeoutSeconds = if ($Action -eq "BuildRestart") { 600 } else { 120 }
    Start-ManagedScriptOperation `
      -Name $scriptName `
      -ArgumentText $argumentText `
      -TimeoutSeconds $timeoutSeconds `
      -Kind Service `
      -Context @{ DisplayName = $displayName }
  } catch {
    Show-ManagerError "$displayName失败" $_.Exception.Message
    $script:operationLabel.Text = "就绪"
    Set-ControlsEnabled $true
    Request-ManagerRefresh -Full -IncludeLogs
  }
}

$script:form = New-Object System.Windows.Forms.Form
$script:form.Text = "ClawBridge 管理器"
$script:form.StartPosition = "CenterScreen"
$script:form.Size = New-Object Drawing.Size(760, 750)
$script:form.MinimumSize = New-Object Drawing.Size(720, 690)
$script:form.Font = New-Object Drawing.Font("Microsoft YaHei UI", 9)
$script:form.AutoScaleMode = [System.Windows.Forms.AutoScaleMode]::Dpi
$script:form.BackColor = [Drawing.Color]::FromArgb(247, 248, 250)

$credentialsGroup = New-Object System.Windows.Forms.GroupBox
$credentialsGroup.Text = "飞书凭据"
$credentialsGroup.Location = New-Object Drawing.Point(16, 14)
$credentialsGroup.Size = New-Object Drawing.Size(710, 205)
$credentialsGroup.Anchor = "Top,Left,Right"
$script:form.Controls.Add($credentialsGroup)

$labels = @("App ID", "App Secret", "Open ID")
$yPositions = @(31, 70, 109)
for ($index = 0; $index -lt $labels.Count; $index++) {
  $label = New-Object System.Windows.Forms.Label
  $label.Text = $labels[$index]
  $label.AutoSize = $true
  $label.Location = New-Object Drawing.Point(18, ($yPositions[$index] + 4))
  $credentialsGroup.Controls.Add($label)
}

$script:appIdBox = New-Object System.Windows.Forms.TextBox
$script:appIdBox.Location = New-Object Drawing.Point(115, 28)
$script:appIdBox.Size = New-Object Drawing.Size(568, 25)
$script:appIdBox.Anchor = "Top,Left,Right"
$credentialsGroup.Controls.Add($script:appIdBox)

$script:secretBox = New-Object System.Windows.Forms.TextBox
$script:secretBox.Location = New-Object Drawing.Point(115, 67)
$script:secretBox.Size = New-Object Drawing.Size(568, 25)
$script:secretBox.Anchor = "Top,Left,Right"
$script:secretBox.UseSystemPasswordChar = $true
$credentialsGroup.Controls.Add($script:secretBox)
$script:secretBox.Add_Enter({
    if ($script:secretPlaceholderActive) {
      $script:secretPlaceholderActive = $false
      $script:secretBox.Clear()
      $script:credentialHint.Text = "输入新的 App Secret 可替换已保存值；保持为空则继续使用原值。"
      $script:credentialHint.ForeColor = [Drawing.Color]::DimGray
    }
  })
$script:secretBox.Add_Leave({
    if ($script:hasSavedSecret -and [string]::IsNullOrWhiteSpace($script:secretBox.Text)) {
      Set-SavedSecretPlaceholder
      $script:credentialHint.Text = "✓ App Secret 已保存；固定占位不代表实际长度。"
      $script:credentialHint.ForeColor = [Drawing.Color]::FromArgb(31, 122, 72)
    }
  })

$script:openIdBox = New-Object System.Windows.Forms.TextBox
$script:openIdBox.Location = New-Object Drawing.Point(115, 106)
$script:openIdBox.Size = New-Object Drawing.Size(448, 25)
$script:openIdBox.Anchor = "Top,Left,Right"
$credentialsGroup.Controls.Add($script:openIdBox)

$openIdHelpButton = New-Object System.Windows.Forms.Button
$openIdHelpButton.Text = "如何获取？"
$openIdHelpButton.Location = New-Object Drawing.Point(573, 104)
$openIdHelpButton.Size = New-Object Drawing.Size(110, 28)
$openIdHelpButton.Anchor = "Top,Right"
$openIdHelpButton.Add_Click({
    $message = @"
有飞书 CLI：
1. 打开 PowerShell，执行 lark-cli auth status --json
2. 复制 identities.user.openId 的 ou_... 值
3. 确认输出中的 App ID 与本窗口一致

没有飞书 CLI：
1. 在 Open ID 中填写 ou_pending_pairing，点击“保存并应用”
2. 在飞书中单聊该机器人，发送“绑定”
3. 机器人会回复当前用户的 ou_... Open ID；配对模式不会执行任务
4. 把回复值替换进本窗口，再点“保存并应用”

Open ID 只对当前飞书应用有效；更换 App ID 后需要重新获取。
"@
    [System.Windows.Forms.MessageBox]::Show(
      $script:form,
      $message.Trim(),
      "如何获取 Open ID",
      [System.Windows.Forms.MessageBoxButtons]::OK,
      [System.Windows.Forms.MessageBoxIcon]::Information
    ) | Out-Null
  })
$credentialsGroup.Controls.Add($openIdHelpButton)

$script:credentialHint = New-Object System.Windows.Forms.Label
$script:credentialHint.Text = "凭据使用 Windows 当前用户加密保存；软件不会回显 App Secret。"
$script:credentialHint.AutoSize = $true
$script:credentialHint.Location = New-Object Drawing.Point(18, 142)
$script:credentialHint.ForeColor = [Drawing.Color]::DimGray
$credentialsGroup.Controls.Add($script:credentialHint)

$script:saveButton = New-Object System.Windows.Forms.Button
$script:saveButton.Text = "保存配置"
$script:saveButton.Location = New-Object Drawing.Point(474, 164)
$script:saveButton.Size = New-Object Drawing.Size(100, 30)
$script:saveButton.Anchor = "Top,Right"
$credentialsGroup.Controls.Add($script:saveButton)

$script:saveStartButton = New-Object System.Windows.Forms.Button
$script:saveStartButton.Text = "保存并应用"
$script:saveStartButton.Location = New-Object Drawing.Point(583, 164)
$script:saveStartButton.Size = New-Object Drawing.Size(100, 30)
$script:saveStartButton.Anchor = "Top,Right"
$credentialsGroup.Controls.Add($script:saveStartButton)

$serviceGroup = New-Object System.Windows.Forms.GroupBox
$serviceGroup.Text = "运行控制"
$serviceGroup.Location = New-Object Drawing.Point(16, 228)
$serviceGroup.Size = New-Object Drawing.Size(710, 130)
$serviceGroup.Anchor = "Top,Left,Right"
$script:form.Controls.Add($serviceGroup)

$script:serviceStatusLabel = New-Object System.Windows.Forms.Label
$script:serviceStatusLabel.Text = "● 正在检查……"
$script:serviceStatusLabel.AutoSize = $true
$script:serviceStatusLabel.Font = New-Object Drawing.Font("Microsoft YaHei UI", 10, [Drawing.FontStyle]::Bold)
$script:serviceStatusLabel.Location = New-Object Drawing.Point(18, 27)
$serviceGroup.Controls.Add($script:serviceStatusLabel)

$script:refreshButton = New-Object System.Windows.Forms.Button
$script:refreshButton.Text = "刷新状态"
$script:refreshButton.Location = New-Object Drawing.Point(583, 20)
$script:refreshButton.Size = New-Object Drawing.Size(100, 30)
$script:refreshButton.Anchor = "Top,Right"
$serviceGroup.Controls.Add($script:refreshButton)

$buttonSpecs = @(
  @{ Name = "startButton"; Text = "启动"; X = 18; Width = 104 },
  @{ Name = "stopButton"; Text = "停止"; X = 132; Width = 104 },
  @{ Name = "restartButton"; Text = "重启"; X = 246; Width = 104 },
  @{ Name = "buildRestartButton"; Text = "构建并重启"; X = 360; Width = 140 }
)
foreach ($spec in $buttonSpecs) {
  $button = New-Object System.Windows.Forms.Button
  $button.Text = $spec.Text
  $button.Location = New-Object Drawing.Point($spec.X, 70)
  $button.Size = New-Object Drawing.Size($spec.Width, 34)
  $serviceGroup.Controls.Add($button)
  Set-Variable -Scope Script -Name $spec.Name -Value $button
}

$autostartGroup = New-Object System.Windows.Forms.GroupBox
$autostartGroup.Text = "电脑登录自启动"
$autostartGroup.Location = New-Object Drawing.Point(16, 367)
$autostartGroup.Size = New-Object Drawing.Size(710, 90)
$autostartGroup.Anchor = "Top,Left,Right"
$script:form.Controls.Add($autostartGroup)

$script:autostartCheckBox = New-Object System.Windows.Forms.CheckBox
$script:autostartCheckBox.Text = "登录 Windows 后自动启动 ClawBridge"
$script:autostartCheckBox.AutoSize = $true
$script:autostartCheckBox.Location = New-Object Drawing.Point(18, 28)
$autostartGroup.Controls.Add($script:autostartCheckBox)

$script:autostartHint = New-Object System.Windows.Forms.Label
$script:autostartHint.Text = "正在读取自启动状态……"
$script:autostartHint.AutoSize = $true
$script:autostartHint.Location = New-Object Drawing.Point(18, 57)
$script:autostartHint.ForeColor = [Drawing.Color]::DimGray
$autostartGroup.Controls.Add($script:autostartHint)

$script:applyAutostartButton = New-Object System.Windows.Forms.Button
$script:applyAutostartButton.Text = "应用设置"
$script:applyAutostartButton.Location = New-Object Drawing.Point(583, 25)
$script:applyAutostartButton.Size = New-Object Drawing.Size(100, 32)
$script:applyAutostartButton.Anchor = "Top,Right"
$autostartGroup.Controls.Add($script:applyAutostartButton)

$logGroup = New-Object System.Windows.Forms.GroupBox
$logGroup.Text = "最近日志（凭据自动隐藏）"
$logGroup.Location = New-Object Drawing.Point(16, 466)
$logGroup.Size = New-Object Drawing.Size(710, 205)
$logGroup.Anchor = "Top,Bottom,Left,Right"
$script:form.Controls.Add($logGroup)

$script:logBox = New-Object System.Windows.Forms.RichTextBox
$script:logBox.Location = New-Object Drawing.Point(12, 24)
$script:logBox.Size = New-Object Drawing.Size(686, 169)
$script:logBox.Anchor = "Top,Bottom,Left,Right"
$script:logBox.ReadOnly = $true
$script:logBox.BackColor = [Drawing.Color]::White
$script:logBox.Font = New-Object Drawing.Font("Consolas", 9)
$script:logBox.WordWrap = $false
$logGroup.Controls.Add($script:logBox)

$script:operationLabel = New-Object System.Windows.Forms.Label
$script:operationLabel.Text = "就绪"
$script:operationLabel.AutoSize = $true
$script:operationLabel.Location = New-Object Drawing.Point(18, 684)
$script:operationLabel.Anchor = "Bottom,Left"
$script:form.Controls.Add($script:operationLabel)

$script:lastRefreshLabel = New-Object System.Windows.Forms.Label
$script:lastRefreshLabel.Text = ""
$script:lastRefreshLabel.AutoSize = $true
$script:lastRefreshLabel.Location = New-Object Drawing.Point(610, 684)
$script:lastRefreshLabel.Anchor = "Bottom,Right"
$script:form.Controls.Add($script:lastRefreshLabel)

$script:operationTimer = New-Object System.Windows.Forms.Timer
$script:operationTimer.Interval = 100
$script:operationTimer.Add_Tick({ Update-ManagedScriptOperation })

$script:refreshPollTimer = New-Object System.Windows.Forms.Timer
$script:refreshPollTimer.Interval = 100
$script:refreshPollTimer.Add_Tick({ Update-ManagerRefresh })

$script:saveButton.Add_Click({
    if ($null -ne $script:activeManagedOperation) { return }
    Set-ControlsEnabled $false
    try { [void](Save-Credentials) } finally { Set-ControlsEnabled $true }
  })

$script:saveStartButton.Add_Click({
    if ($null -ne $script:activeManagedOperation) { return }
    Set-ControlsEnabled $false
    try {
      if (Save-Credentials) {
        # restart.ps1 is deliberately idempotent and also starts a stopped
        # Bridge, so no synchronous status probe is needed on the UI thread.
        Invoke-ServiceAction -Action Restart
      }
    } finally {
      if ($null -eq $script:activeManagedOperation) {
        Set-ControlsEnabled $true
      }
    }
  })

$script:startButton.Add_Click({ Invoke-ServiceAction -Action Start })
$script:stopButton.Add_Click({ Invoke-ServiceAction -Action Stop })
$script:restartButton.Add_Click({ Invoke-ServiceAction -Action Restart })
$script:buildRestartButton.Add_Click({ Invoke-ServiceAction -Action BuildRestart })
$script:refreshButton.Add_Click({ Request-ManagerRefresh -Full -IncludeLogs })

$script:applyAutostartButton.Add_Click({
    if ($script:updatingAutostart -or $null -ne $script:activeManagedOperation) { return }
    Invalidate-ManagerRefresh
    Set-ControlsEnabled $false
    $script:operationLabel.Text = "正在更新登录自启动，请稍候……"
    try {
      $mode = if ($script:autostartCheckBox.Checked) { "Install" } else { "Uninstall" }
      $argumentText = Get-AutostartArgumentText -Mode $mode
      Start-ManagedScriptOperation `
        -Name "autostart.ps1" `
        -ArgumentText $argumentText `
        -TimeoutSeconds 60 `
        -Kind Autostart `
        -Context @{ Mode = $mode }
    } catch {
      $message = $_.Exception.Message
      if ($message -match '(?i)Autostart was refused|writable by|untrusted owner') {
        $message = "安全检查发现当前项目目录可被其他本机账户修改，因此没有启用登录自启动，也没有更改任何目录权限。请把项目移到当前用户私有目录，或在确认影响后单独收紧该目录的 ACL。`r`n`r`n详细信息：`r`n$message"
      }
      Show-ManagerError "自启动设置失败" $message
      $script:operationLabel.Text = "就绪"
      Set-ControlsEnabled $true
      Request-ManagerRefresh -Full
    }
  })

$script:statusTimer = New-Object System.Windows.Forms.Timer
$script:statusTimer.Interval = 10000
$script:statusTimer.Add_Tick({
    if ($null -eq $script:activeManagedOperation -and
        $null -eq $script:activeRefreshOperation) {
      Request-ManagerRefresh
    }
  })

$script:form.Add_Shown({
    Load-SavedCredentialFields
    Request-ManagerRefresh -Full -IncludeLogs
    $script:statusTimer.Start()
  })
$script:form.Add_FormClosed({
    if ($null -ne $script:statusTimer) {
      $script:statusTimer.Stop()
      $script:statusTimer.Dispose()
    }
    if ($null -ne $script:operationTimer) {
      $script:operationTimer.Stop()
      $script:operationTimer.Dispose()
    }
    if ($null -ne $script:refreshPollTimer) {
      $script:refreshPollTimer.Stop()
      $script:refreshPollTimer.Dispose()
    }
    if ($null -ne $script:activeRefreshOperation) {
      foreach ($job in $script:activeRefreshOperation.Jobs) {
        if ($null -ne $job.Process) {
          try {
            if (-not $job.Process.HasExited) { $job.Process.Kill() }
          } catch {}
          $job.Process.Dispose()
        }
        Remove-ManagedScriptResult -ResultPath $job.ResultPath
      }
      $script:activeRefreshOperation = $null
    }
  })
$script:form.Add_FormClosing({
    param($sender, $eventArgs)
    if ($null -ne $script:activeManagedOperation) {
      $eventArgs.Cancel = $true
      [System.Windows.Forms.MessageBox]::Show(
        $script:form,
        "当前操作仍在执行，请等待完成后再关闭管理器。",
        "ClawBridge 正在处理",
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Information
      ) | Out-Null
    }
  })

[void][System.Windows.Forms.Application]::Run($script:form)
