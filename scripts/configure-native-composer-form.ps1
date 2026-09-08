[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$AppToken,
  [string]$TableId,
  [switch]$Dedicated,
  [string]$CredentialPath
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "lib\ClawBridge.Common.ps1")

if (-not $Dedicated -and [string]::IsNullOrWhiteSpace($TableId)) {
  throw "Specify -Dedicated or -TableId."
}
if ($Dedicated -and -not [string]::IsNullOrWhiteSpace($TableId)) {
  throw "Dedicated and TableId are mutually exclusive."
}
if ([string]::IsNullOrWhiteSpace($CredentialPath)) {
  $CredentialPath = Get-ClawBridgeCredentialPath
}

$credentials = Read-ClawBridgeCredentials -CredentialPath ([IO.Path]::GetFullPath($CredentialPath))
$previousAppId = [Environment]::GetEnvironmentVariable("CLAWBRIDGE_FEISHU_APP_ID", "Process")
$previousAppSecret = [Environment]::GetEnvironmentVariable("CLAWBRIDGE_FEISHU_APP_SECRET", "Process")
try {
  [Environment]::SetEnvironmentVariable("CLAWBRIDGE_FEISHU_APP_ID", $credentials.AppId, "Process")
  [Environment]::SetEnvironmentVariable("CLAWBRIDGE_FEISHU_APP_SECRET", $credentials.AppSecret, "Process")
  $arguments = @(
    (Join-Path $PSScriptRoot "configure-native-composer-form.mjs"),
    "--app-token",
    $AppToken
  )
  if ($Dedicated) {
    $arguments += "--dedicated"
  } else {
    $arguments += @("--table-id", $TableId)
  }
  & node @arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Native composer form configuration failed with exit code $LASTEXITCODE."
  }
} finally {
  [Environment]::SetEnvironmentVariable("CLAWBRIDGE_FEISHU_APP_ID", $previousAppId, "Process")
  [Environment]::SetEnvironmentVariable("CLAWBRIDGE_FEISHU_APP_SECRET", $previousAppSecret, "Process")
}
