function Invoke-SourceBuildLock([scriptblock]$Action) {
    $root = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot)).ToLowerInvariant()
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $key = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($root))).Replace('-', '') } finally { $sha.Dispose() }
    $mutex = New-Object Threading.Mutex($false, ('Local\CherryToolboxBuild-' + $key))
    $acquired = $false
    try {
        try { $acquired = $mutex.WaitOne(120000) } catch [Threading.AbandonedMutexException] { $acquired = $true }
        if (-not $acquired) { throw 'Another source build is still running. Wait for it to finish and retry.' }
        & $Action
    } finally {
        if ($acquired) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
    }
}
