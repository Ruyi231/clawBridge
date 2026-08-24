[CmdletBinding()]
param(
  [string]$Config = "config/local.yaml",
  [string]$CredentialPath
)

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
. (Join-Path $PSScriptRoot "lib\ClawBridge.Common.ps1")
if ([string]::IsNullOrWhiteSpace($CredentialPath)) {
  $CredentialPath = Get-ClawBridgeCredentialPath
}
$failures = 0

function Test-Check([string]$Name, [scriptblock]$Check) {
  try {
    & $Check
    Write-Output "[OK] $Name"
  } catch {
    $script:failures++
    Write-Output "[FAIL] $Name - $($_.Exception.Message)"
  }
}

Test-Check "Node.js" { Get-Command node -CommandType Application -ErrorAction Stop | Out-Null }
$configPath = if ([IO.Path]::IsPathRooted($Config)) { $Config } else { Join-Path $projectRoot $Config }
Test-Check "Config file" { Resolve-Path -LiteralPath $configPath -ErrorAction Stop | Out-Null }
Test-Check "Build output" { if (-not (Test-Path (Join-Path $projectRoot "dist\src\app.js"))) { throw "run npm run build" } }
Test-Check "Encrypted Feishu credentials" {
  $credentials = Read-ClawBridgeCredentials -CredentialPath $CredentialPath
  $credentials = $null
}
Test-Check "Codex command" { Get-Command codex -ErrorAction Stop | Out-Null }
Test-Check "Project paths" {
  Push-Location $projectRoot
  try {
    & node "scripts/verify-project-paths.mjs" --config $configPath
    if ($LASTEXITCODE -ne 0) { throw "project path verification failed" }
  } finally {
    Pop-Location
  }
}

if ($failures -gt 0) { exit 1 }
