param([Parameter(Mandatory = $true)][string]$Archive)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$projectDirectory = Split-Path -Parent $PSScriptRoot
$outputDirectory = Join-Path $projectDirectory 'native\bin'
[IO.Directory]::CreateDirectory($outputDirectory) | Out-Null
$zip = [IO.Compression.ZipFile]::OpenRead($Archive)
try {
  $entries = @($zip.Entries | Where-Object { $_.FullName -eq 'mihomo-windows-amd64-compatible.exe' })
  if ($entries.Count -ne 1) { throw 'Unexpected official archive layout.' }
  [IO.Compression.ZipFileExtensions]::ExtractToFile($entries[0], (Join-Path $outputDirectory 'mihomo.exe'), $true)
} finally { $zip.Dispose() }
