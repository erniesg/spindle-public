@echo off
setlocal
set "ROOT=%~dp0"
if not exist "%ROOT%contracts\capture-check.package.json" set "ROOT=%~dp0..\..\"
set "NODE=%ROOT%runtime\node.exe"
if exist "%NODE%" goto launch
where node.exe >nul 2>nul
if errorlevel 1 (
  echo This source checkout needs Node 22+. The review ZIP includes it.
  echo No software or machine settings were changed.
  pause
  exit /b 1
)
set "NODE=node.exe"
:launch
if not exist "%ROOT%build\core\capture-check\app.js" (
  echo Source checkout: run npm ci --ignore-scripts and npm run build first. Review ZIPs include generated JavaScript.
  exit /b 1
)
"%NODE%" "%ROOT%build\core\capture-check\app.js"
if errorlevel 1 (
  echo Spindle runner failed to start. Keep the build ID from READ ME FIRST.txt for feedback.
  pause
)
endlocal
