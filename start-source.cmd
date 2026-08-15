@echo off
setlocal EnableExtensions
chcp 65001 >nul
title Connection Switcher - Source

set "NS_ROOT=%~dp0"
set "NS_NODE="
set "NS_ELECTRON_ARG="

for /f "delims=" %%I in ('where node.exe 2^>nul') do if not defined NS_NODE set "NS_NODE=%%I"
if not defined NS_NODE goto :missing_node
"%NS_NODE%" -e "const [major, minor] = process.versions.node.split('.').map(Number); process.exit(major > 22 || (major === 22 && minor >= 12) ? 0 : 1)"
if errorlevel 1 goto :unsupported_node

pushd "%NS_ROOT%" || goto :invalid_root

if not exist "package.json" goto :invalid_project
if not exist "tsconfig.json" goto :invalid_project
if not exist "node_modules\typescript\lib\tsc.js" goto :missing_dependencies
if not exist "node_modules\electron\dist\electron.exe" goto :missing_dependencies

if /I "%~1"=="--check" goto :check_ok
if /I "%~1"=="--hidden" set "NS_ELECTRON_ARG=--hidden"
if not "%~1"=="" if /I not "%~1"=="--hidden" goto :invalid_argument

echo [1/2] Compiling TypeScript...
"%NS_NODE%" "node_modules\typescript\lib\tsc.js" -p "tsconfig.json"
if errorlevel 1 goto :build_failed

echo [2/2] Starting Connection Switcher...
"node_modules\electron\dist\electron.exe" . %NS_ELECTRON_ARG%
set "NS_EXIT_CODE=%ERRORLEVEL%"
popd

if not "%NS_EXIT_CODE%"=="0" (
  echo.
  echo [ERROR] Connection Switcher exited with code %NS_EXIT_CODE%.
  if not defined NS_NO_PAUSE pause
)
exit /b %NS_EXIT_CODE%

:check_ok
echo Source runtime is ready.
echo Node: %NS_NODE%
popd
exit /b 0

:missing_node
echo [ERROR] node.exe was not found in PATH.
echo Install Node.js 22.12 or later, then reopen this script.
if not defined NS_NO_PAUSE pause
exit /b 1

:unsupported_node
echo [ERROR] The installed Node.js version is too old.
echo Install Node.js 22.12 or later, then reopen this script.
if not defined NS_NO_PAUSE pause
exit /b 1

:missing_dependencies
echo [ERROR] Project dependencies are missing or incomplete.
echo Open a terminal in "%NS_ROOT%" and run: npm ci
popd
if not defined NS_NO_PAUSE pause
exit /b 1

:invalid_argument
echo [ERROR] Unsupported argument: %~1
echo Usage: start-source.cmd [--hidden ^| --check]
popd
if not defined NS_NO_PAUSE pause
exit /b 2

:build_failed
echo.
echo [ERROR] TypeScript compilation failed. Review the messages above.
popd
if not defined NS_NO_PAUSE pause
exit /b 1

:invalid_project
echo [ERROR] package.json or tsconfig.json is missing from "%NS_ROOT%".
popd
if not defined NS_NO_PAUSE pause
exit /b 1

:invalid_root
echo [ERROR] Unable to open the project directory "%NS_ROOT%".
if not defined NS_NO_PAUSE pause
exit /b 1
