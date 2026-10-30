@echo off
setlocal
set "ROOT=%~dp0"
if not exist "%ROOT%build\core\preview\app.js" set "ROOT=%~dp0..\..\"
if not exist "%ROOT%runtime\node.exe" (
 echo Use the complete extracted Windows preview ZIP. No software was installed.
 exit /b 2
)
"%ROOT%runtime\node.exe" "%ROOT%build\core\preview\app.js" %*
endlocal
