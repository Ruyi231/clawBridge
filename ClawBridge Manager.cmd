@echo off
setlocal
set "CLAWBRIDGE_MANAGER=%~dp0scripts\launch-manager.ps1"
if not exist "%CLAWBRIDGE_MANAGER%" (
  echo ClawBridge manager script was not found.
  pause
  exit /b 1
)
start "ClawBridge Manager" "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File "%CLAWBRIDGE_MANAGER%"
endlocal
