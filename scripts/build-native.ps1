$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'build-lock.ps1')

Invoke-SourceBuildLock {
    $projectDirectory = Split-Path -Parent $PSScriptRoot
    $nativeDirectory = Join-Path $projectDirectory 'native'
    $outputDirectory = Join-Path $nativeDirectory 'bin'
    $compilerPath = Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
    if (-not (Test-Path -LiteralPath $compilerPath)) { throw '.NET Framework 4.x C# compiler is required on Windows.' }
    New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
    $utf8 = New-Object Text.UTF8Encoding($false)
    $sha = [Security.Cryptography.SHA256]::Create()
    function Get-Digest([byte[]]$Bytes) {
        return [BitConverter]::ToString($sha.ComputeHash($Bytes)).Replace('-', '').ToLowerInvariant()
    }
    function Write-GeneratedText([string]$File, [string]$Text) {
        if ((Test-Path -LiteralPath $File) -and [IO.File]::ReadAllText($File) -ceq $Text) { return }
        $temporary = $File + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
        try {
            [IO.File]::WriteAllText($temporary, $Text, $utf8)
            if (Test-Path -LiteralPath $File) { [IO.File]::Replace($temporary, $File, [NullString]::Value) }
            else { [IO.File]::Move($temporary, $File) }
        } finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary } }
    }
    try {
        $compilerOptions = @('/nologo', '/target:exe', '/platform:x64', '/optimize+', '/warnaserror+', '/reference:System.Management.dll', '/reference:System.Web.Extensions.dll')
        $sources = @(Get-ChildItem -LiteralPath $nativeDirectory -Filter '*.cs' | Sort-Object Name | ForEach-Object {
            $bytes = [IO.File]::ReadAllBytes($_.FullName)
            [pscustomobject]@{ Name = $_.Name; Bytes = $bytes; Hash = (Get-Digest $bytes) }
        })
        if ($sources.Count -eq 0) { throw 'No native helper sources were found.' }
        $inputs = @('helper-build-v2', (Get-Digest ([IO.File]::ReadAllBytes($compilerPath))), ($compilerOptions -join ' '))
        $inputs += @($sources | ForEach-Object { $_.Name + ':' + $_.Hash })
        $inputHash = Get-Digest ($utf8.GetBytes(($inputs -join [char]10)))
        $manifestPath = Join-Path $outputDirectory 'helper-manifest.json'
        $manifest = $null
        if (Test-Path -LiteralPath $manifestPath) {
            try {
                $candidate = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
                if ($candidate.version -eq 2 -and $candidate.inputSha256 -ceq $inputHash -and $candidate.sha256 -cmatch '^[a-f0-9]{64}$') {
                    $expectedPath = 'helpers/' + $candidate.sha256 + '/CherryToolbox.Helper.exe'
                    $candidatePath = Join-Path $outputDirectory $expectedPath
                    if ($candidate.relativePath -ceq $expectedPath -and (Test-Path -LiteralPath $candidatePath) -and (Get-Digest ([IO.File]::ReadAllBytes($candidatePath))) -ceq $candidate.sha256) {
                        $manifest = $candidate
                    }
                }
            } catch { Write-Output 'Helper cache could not be verified; compiling a new immutable version.' }
        }
        if ($null -eq $manifest) {
            $staging = Join-Path $outputDirectory ('.staging-' + [guid]::NewGuid().ToString('N'))
            New-Item -ItemType Directory -Path $staging | Out-Null
            try {
                $sourcePaths = @($sources | ForEach-Object {
                    $file = Join-Path $staging $_.Name
                    [IO.File]::WriteAllBytes($file, $_.Bytes)
                    $file
                })
                $binary = Join-Path $staging 'CherryToolbox.Helper.exe'
                & $compilerPath @compilerOptions ('/out:' + $binary) @sourcePaths
                if ($LASTEXITCODE -ne 0) { throw 'The native safety helper did not compile.' }
                $digest = Get-Digest ([IO.File]::ReadAllBytes($binary))
                $relativePath = 'helpers/' + $digest + '/CherryToolbox.Helper.exe'
                $destination = Join-Path $outputDirectory $relativePath
                New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
                if (Test-Path -LiteralPath $destination) {
                    if ((Get-Digest ([IO.File]::ReadAllBytes($destination))) -cne $digest) { throw 'An immutable helper file has been modified. It will not be overwritten.' }
                } else { [IO.File]::Move($binary, $destination) }
                $manifest = [ordered]@{ version = 2; sha256 = $digest; inputSha256 = $inputHash; relativePath = $relativePath }
            } finally {
                $resolvedStaging = [IO.Path]::GetFullPath($staging)
                if ([IO.Path]::GetDirectoryName($resolvedStaging) -cne [IO.Path]::GetFullPath($outputDirectory) -or [IO.Path]::GetFileName($resolvedStaging) -notmatch '^\.staging-[a-f0-9]{32}$') { throw 'Unsafe helper staging cleanup path.' }
                Remove-Item -LiteralPath $resolvedStaging -Recurse -Force
            }
            Write-Output 'Windows safety helper compiled into an immutable version directory.'
        } else { Write-Output 'Reusing the verified Windows safety helper; build inputs are unchanged.' }
        Write-GeneratedText $manifestPath ($manifest | ConvertTo-Json -Compress)
        $generated = @('// Generated by scripts/build-native.ps1. Running processes retain this version.',
            ("export const NATIVE_HELPER_SHA256 = '" + $manifest.sha256 + "';"),
            ("export const NATIVE_HELPER_RELATIVE_PATH = '" + $manifest.relativePath + "';"), '') -join [char]10
        Write-GeneratedText (Join-Path $projectDirectory 'src\main\native-manifest.ts') $generated
    } finally { $sha.Dispose() }
}
