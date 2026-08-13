[CmdletBinding()]
param(
  [string]$AppId,
  [Security.SecureString]$AppSecret,
  [string]$OpenId,
  [string]$CredentialPath,
  [switch]$PreserveExistingSecret
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "lib\ClawBridge.Common.ps1")

if ([string]::IsNullOrWhiteSpace($AppId)) {
  $AppId = Read-Host "Feishu App ID (cli_...)"
}
if ($null -eq $AppSecret -and -not $PreserveExistingSecret) {
  $AppSecret = Read-Host "Feishu App Secret" -AsSecureString
}
if ($PreserveExistingSecret -and $null -ne $AppSecret) {
  throw "AppSecret and PreserveExistingSecret are mutually exclusive."
}
if ([string]::IsNullOrWhiteSpace($OpenId)) {
  $OpenId = Read-Host "Allowed Feishu Open ID (ou_...)"
}
if ([string]::IsNullOrWhiteSpace($CredentialPath)) {
  $CredentialPath = Get-ClawBridgeCredentialPath
}

$saveArguments = @{
  AppId = $AppId
  OpenId = $OpenId
  CredentialPath = $CredentialPath
}
if ($PreserveExistingSecret) {
  $saveArguments.PreserveExistingSecret = $true
} else {
  $saveArguments.AppSecret = $AppSecret
}
Save-ClawBridgeCredentials @saveArguments
Write-Output "Credentials were encrypted for the current Windows user and saved successfully."
