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

if /I "%~1"=="--check" goto :check_ok
if /I "%~1"=="--hidden" set "CT_ELECTRON_ARG=--hidden"
if not "%~1"=="" if /I not "%~1"=="--hidden" goto :invalid_argument

echo [1/3] Compiling main process...
"%CT_NODE%" "node_modules\typescript\lib\tsc.js" -p "tsconfig.json"
if errorlevel 1 goto :build_failed

echo [2/3] Compiling renderer...
"%CT_NODE%" "node_modules\typescript\lib\tsc.js" -p "tsconfig.renderer.json"
if errorlevel 1 goto :build_failed

echo [3/3] Starting Cherry Toolbox...
"node_modules\electron\dist\electron.exe" . %CT_ELECTRON_ARG%
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

:invalid_argument
echo [ERROR] Unsupported argument: %~1
echo Usage: start-source.cmd [--hidden ^| --check]
popd
if not defined CT_NO_PAUSE pause
exit /b 2

:build_failed
echo.
echo [ERROR] TypeScript compilation failed. Review the messages above.
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
