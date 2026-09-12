param([switch]$Child)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
    throw 'This runner is only for GitHub-hosted Windows CI. Run npm run verify locally as a normal user.'
}
$projectDirectory = Split-Path -Parent $PSScriptRoot
$temporaryDirectory = Join-Path $projectDirectory '.tmp'
New-Item -ItemType Directory -Path $temporaryDirectory -Force | Out-Null
$logPath = Join-Path $temporaryDirectory 'ci-standard-user.log'
$resultPath = Join-Path $temporaryDirectory 'ci-standard-user.exit'

if ($Child) {
    $verificationExit = 1
    try {
        $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
        if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
            throw 'CI tests must run without administrator privileges.'
        }
        Set-Location -LiteralPath $projectDirectory
        & npm.cmd run verify *> $logPath
        $verificationExit = $LASTEXITCODE
    } catch {
        $_ | Out-String | Add-Content -LiteralPath $logPath
    } finally {
        [IO.File]::WriteAllText($resultPath, [string]$verificationExit)
    }
    exit $verificationExit
}

Remove-Item -LiteralPath $logPath, $resultPath -Force -ErrorAction SilentlyContinue
# Basic User keeps the runner's profile/workspace while filtering administrator rights.
# No application safety checks, user accounts, or system networking settings are changed.
$command = "& '" + $PSCommandPath.Replace("'", "''") + "' -Child"
$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
$arguments = '/trustlevel:0x20000 "powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand ' + $encoded + '"'
$launcher = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\runas.exe') -ArgumentList $arguments -WindowStyle Hidden -PassThru -Wait
if ($launcher.ExitCode -ne 0) { throw ('Unable to start the standard-user test process: ' + $launcher.ExitCode) }
$deadline = [DateTime]::UtcNow.AddMinutes(8)
while (-not (Test-Path -LiteralPath $resultPath)) {
    if ([DateTime]::UtcNow -gt $deadline) { throw 'The standard-user test process did not finish within eight minutes.' }
    Start-Sleep -Seconds 2
}
if (Test-Path -LiteralPath $logPath) { Get-Content -LiteralPath $logPath }
$verificationExit = [int][IO.File]::ReadAllText($resultPath)
if ($verificationExit -ne 0) { throw ('Standard-user verification failed: ' + $verificationExit) }
