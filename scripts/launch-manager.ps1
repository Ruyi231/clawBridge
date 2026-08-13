$ErrorActionPreference = "Stop"

$managerPath = Join-Path $PSScriptRoot "clawbridge-manager.ps1"
if (-not (Test-Path -LiteralPath $managerPath)) {
  throw "ClawBridge manager script was not found."
}

$previousScriptRoot = $env:CLAWBRIDGE_MANAGER_SCRIPT_ROOT
$env:CLAWBRIDGE_MANAGER_SCRIPT_ROOT = $PSScriptRoot
try {
  $source = Get-Content -LiteralPath $managerPath -Encoding UTF8 -Raw
  & ([ScriptBlock]::Create($source))
} finally {
  if ($null -eq $previousScriptRoot) {
    Remove-Item Env:\CLAWBRIDGE_MANAGER_SCRIPT_ROOT -ErrorAction SilentlyContinue
  } else {
    $env:CLAWBRIDGE_MANAGER_SCRIPT_ROOT = $previousScriptRoot
  }
}
