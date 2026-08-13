[CmdletBinding()]
param([switch]$RegisterTask)

$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Push-Location $projectRoot
try {
  if (-not (Test-Path "config/local.yaml")) { Copy-Item "config/default.example.yaml" "config/local.yaml" }
  if (-not (Test-Path "config/projects.yaml")) { Copy-Item "config/projects.example.yaml" "config/projects.yaml" }
  & npm ci
  if ($LASTEXITCODE -ne 0) { throw "npm ci failed with exit code $LASTEXITCODE." }
  & npm run build
  if ($LASTEXITCODE -ne 0) { throw "npm run build failed with exit code $LASTEXITCODE." }

  if ($RegisterTask) {
    & (Join-Path $PSScriptRoot "autostart.ps1") -Action Install
  }
} finally {
  Pop-Location
}
