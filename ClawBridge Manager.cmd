@echo off
setlocal
set "CLAWBRIDGE_MANAGER=%~dp0ClawBridge Manager.vbs"
if not exist "%CLAWBRIDGE_MANAGER%" (
  echo ClawBridge manager launcher was not found.
  pause
  exit /b 1
)
"%SystemRoot%\System32\wscript.exe" //B "%CLAWBRIDGE_MANAGER%"
endlocal
