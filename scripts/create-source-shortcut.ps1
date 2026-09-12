[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$launcherPath = Join-Path $projectRoot 'start-source.vbs'
$iconPath = Join-Path $projectRoot 'static\assets\cherry-toolbox.ico'
$shortcutPath = Join-Path $projectRoot 'Cherry Toolbox.lnk'
$wscriptPath = Join-Path $env:SystemRoot 'System32\wscript.exe'

foreach ($requiredPath in @($launcherPath, $iconPath, $wscriptPath)) {
    if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
        throw "Required shortcut resource was not found: $requiredPath"
    }
}

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $wscriptPath
$shortcut.Arguments = '"' + $launcherPath + '"'
$shortcut.WorkingDirectory = $projectRoot
$shortcut.IconLocation = $iconPath + ',0'
$shortcut.Description = 'Launch Cherry Toolbox from source'
$shortcut.WindowStyle = 1
$shortcut.Save()

Write-Host "Created source shortcut: $shortcutPath"
