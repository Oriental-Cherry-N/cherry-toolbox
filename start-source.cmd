@echo off
setlocal EnableExtensions
chcp 65001 >nul
title Cherry Toolbox - Source

set "CT_ROOT=%~dp0"
set "CT_NODE="
set "CT_ELECTRON_ARG="

for /f "delims=" %%I in ('where node.exe 2^>nul') do if not defined CT_NODE set "CT_NODE=%%I"
if not defined CT_NODE goto :missing_node
"%CT_NODE%" -e "const [major, minor] = process.versions.node.split('.').map(Number); process.exit(major > 22 || (major === 22 && minor >= 12) ? 0 : 1)"
if errorlevel 1 goto :unsupported_node

pushd "%CT_ROOT%" || goto :invalid_root

if not exist "package.json" goto :invalid_project
if not exist "tsconfig.json" goto :invalid_project
if not exist "tsconfig.renderer.json" goto :invalid_project
if not exist "node_modules\typescript\lib\tsc.js" goto :missing_dependencies
if not exist "node_modules\electron\dist\electron.exe" goto :missing_dependencies
if not exist "%SystemRoot%\Microsoft.NET\Framework64\v4.0.30319\csc.exe" goto :missing_native_runtime

if /I "%~1"=="--check" goto :check_ok
if /I "%~1"=="--hidden" set "CT_ELECTRON_ARG=-Hidden"
if not "%~1"=="" if /I not "%~1"=="--hidden" goto :invalid_argument

echo Checking the running instance before building...
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "scripts\build-source.ps1" -Mode Launch %CT_ELECTRON_ARG%
set "CT_EXIT_CODE=%ERRORLEVEL%"
popd

if not "%CT_EXIT_CODE%"=="0" (
  echo.
  echo [ERROR] Cherry Toolbox exited with code %CT_EXIT_CODE%.
  if not defined CT_NO_PAUSE pause
)
exit /b %CT_EXIT_CODE%

:check_ok
echo Source runtime is ready.
echo Node: %CT_NODE%
if exist "native\bin\mihomo.exe" (
  echo Dedicated routing core: installed
) else (
  echo [WARNING] Dedicated routing core is missing.
  echo Run: node scripts\setup-routing-core.cjs
)
if exist ".python-envs\wechat-auto-reply\python.exe" (
  echo WeChat Auto Reply: ready
) else (
  echo [WARNING] WeChat Auto Reply environment is missing.
  echo Run: powershell -ExecutionPolicy Bypass -File scripts\setup-wechat-auto-reply.ps1
)
popd
exit /b 0

:missing_node
echo [ERROR] node.exe was not found in PATH.
echo Install Node.js 22.12 or later, then reopen this script.
if not defined CT_NO_PAUSE pause
exit /b 1

:unsupported_node
echo [ERROR] The installed Node.js version is too old.
echo Install Node.js 22.12 or later, then reopen this script.
if not defined CT_NO_PAUSE pause
exit /b 1

:missing_dependencies
echo [ERROR] Project dependencies are missing or incomplete.
echo Open a terminal in "%CT_ROOT%" and run: npm ci
popd
if not defined CT_NO_PAUSE pause
exit /b 1

:missing_native_runtime
echo [ERROR] The Windows .NET Framework compiler is unavailable.
popd
if not defined CT_NO_PAUSE pause
exit /b 1

:invalid_argument
echo [ERROR] Unsupported argument: %~1
echo Usage: start-source.cmd [--hidden ^| --check]
popd
if not defined CT_NO_PAUSE pause
exit /b 2

:build_failed
echo.
echo [ERROR] Source build failed. Review the messages above.
popd
if not defined CT_NO_PAUSE pause
exit /b 1

:invalid_project
echo [ERROR] A required project or TypeScript configuration file is missing from "%CT_ROOT%".
popd
if not defined CT_NO_PAUSE pause
exit /b 1

:invalid_root
echo [ERROR] Unable to open the project directory "%CT_ROOT%".
if not defined CT_NO_PAUSE pause
exit /b 1
