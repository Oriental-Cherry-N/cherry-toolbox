param(
    [ValidateSet('All', 'Main', 'Renderer', 'Check', 'Launch')][string]$Mode = 'All',
    [switch]$Hidden
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'build-lock.ps1')
$projectDirectory = Split-Path -Parent $PSScriptRoot
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$electronPath = Join-Path $projectDirectory 'node_modules\electron\dist\electron.exe'
$probePath = Join-Path $PSScriptRoot 'source-instance.cjs'

function Test-ExistingInstance([switch]$Quiet) {
    $probe = New-Object Diagnostics.Process
    $probe.StartInfo.FileName = $electronPath
    $probe.StartInfo.Arguments = '"' + $probePath + '"'
    if ($Quiet) { $probe.StartInfo.Arguments += ' --quiet' }
    $probe.StartInfo.WorkingDirectory = $projectDirectory
    $probe.StartInfo.UseShellExecute = $false
    $probe.StartInfo.CreateNoWindow = $true
    $probe.StartInfo.RedirectStandardOutput = $true
    $probe.StartInfo.RedirectStandardError = $true
    try {
        if (-not $probe.Start()) { throw 'The application instance check could not start.' }
        $stdout = $probe.StandardOutput.ReadToEndAsync()
        $stderr = $probe.StandardError.ReadToEndAsync()
        if (-not $probe.WaitForExit(10000)) {
            # This is only the short-lived probe, never the running application.
            $probe.Kill()
            throw 'The application instance check timed out. No build was started.'
        }
        if ($probe.ExitCode -eq 0) { return $true }
        if ($probe.ExitCode -eq 42) { return $false }
        throw ('The application instance check failed (exit ' + $probe.ExitCode + '). No build was started. ' + $stderr.Result + $stdout.Result)
    } finally { $probe.Dispose() }
}
function Invoke-NodeStep([string[]]$NodeArguments) {
    & $nodePath @NodeArguments
    if ($LASTEXITCODE -ne 0) { throw ('Source step failed: ' + ($NodeArguments -join ' ')) }
}

Push-Location -LiteralPath $projectDirectory
try {
    if ($Mode -eq 'Launch' -and (Test-ExistingInstance)) {
        Write-Output 'Activated the running Cherry Toolbox. No files were rebuilt.'
        exit 0
    }
    $script:launchedApplication = $null
    Invoke-SourceBuildLock {
        # Another double-click may have launched the app while we waited for the lock.
        if ($Mode -eq 'Launch' -and (Test-ExistingInstance)) {
            Write-Output 'Activated the running Cherry Toolbox. No files were rebuilt.'
            return
        }
        Invoke-NodeStep @('scripts/harden-build-dependencies.cjs')
        if ($Mode -ne 'Renderer') { & (Join-Path $PSScriptRoot 'build-native.ps1') }
        if ($Mode -ne 'Renderer') {
            $arguments = @('node_modules/typescript/lib/tsc.js', '-p', 'tsconfig.json')
            if ($Mode -eq 'Check') { $arguments += '--noEmit' }
            Invoke-NodeStep $arguments
        }
        if ($Mode -ne 'Main') {
            $arguments = @('node_modules/typescript/lib/tsc.js', '-p', 'tsconfig.renderer.json')
            if ($Mode -eq 'Check') { $arguments += '--noEmit' }
            Invoke-NodeStep $arguments
        }
        if ($Mode -eq 'Launch') {
            $logDirectory = Join-Path $projectDirectory '.tmp'
            New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
            $logPrefix = Join-Path $logDirectory ('source-' + [guid]::NewGuid().ToString('N'))
            $arguments = @('.')
            if ($Hidden) { $arguments += '--hidden' }
            $script:launchedApplication = Start-Process -FilePath $electronPath -ArgumentList $arguments -WorkingDirectory $projectDirectory -WindowStyle Hidden -PassThru -RedirectStandardOutput ($logPrefix + '.log') -RedirectStandardError ($logPrefix + '.error.log')
            Write-Output ('Application diagnostics: ' + $logPrefix + '.error.log')
            $deadline = [DateTime]::UtcNow.AddSeconds(20)
            do {
                if ($script:launchedApplication.HasExited) { throw 'The application exited during startup. See the diagnostic log.' }
                if (Test-ExistingInstance -Quiet) { return }
                Start-Sleep -Milliseconds 100
            } while ([DateTime]::UtcNow -lt $deadline)
            throw 'Application startup has not been confirmed. See the diagnostic log before retrying.'
        }
    }
    if ($null -ne $script:launchedApplication) {
        $script:launchedApplication.WaitForExit()
        exit $script:launchedApplication.ExitCode
    }
} finally { Pop-Location }
