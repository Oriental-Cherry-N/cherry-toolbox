param(
  [string]$CondaPath = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$projectRoot = Split-Path -Parent $PSScriptRoot
$environmentPath = Join-Path $projectRoot '.python-envs\wechat-auto-reply'
$pythonPath = Join-Path $environmentPath 'python.exe'
$dependencyLock = Join-Path $projectRoot 'python\requirements-wechat-auto-reply.lock'
$upstreamCommit = '109724b7b9d50b0914d33b778caf220415f10360'
$upstreamVersion = '1.9.8'
$upstreamPackage = "git+https://github.com/Hello-Mr-Crab/pywechat.git@$upstreamCommit#subdirectory=src"

if ([string]::IsNullOrWhiteSpace($CondaPath)) {
  $command = Get-Command conda.exe -ErrorAction SilentlyContinue
  $candidates = @(
    $(if ($null -ne $command) { $command.Source }),
    (Join-Path $env:USERPROFILE 'miniconda3\Scripts\conda.exe'),
    (Join-Path $env:USERPROFILE 'Miniconda3\Scripts\conda.exe'),
    'C:\ProgramData\miniconda3\Scripts\conda.exe',
    'C:\ProgramData\Miniconda3\Scripts\conda.exe'
  )
  $CondaPath = $candidates |
    Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } |
    Select-Object -First 1
}

if (-not $CondaPath -or -not (Test-Path -LiteralPath $CondaPath -PathType Leaf)) {
  throw 'Miniconda was not found. Pass its conda.exe path with -CondaPath.'
}

if (-not (Test-Path -LiteralPath $pythonPath -PathType Leaf)) {
  Write-Host "Creating the dedicated Python environment at $environmentPath"
  & $CondaPath create --prefix $environmentPath --override-channels --channel conda-forge python=3.11 pip -y
  if ($LASTEXITCODE -ne 0) {
    throw "Miniconda environment creation failed with exit code $LASTEXITCODE."
  }
}

Write-Host 'Installing hash-locked Python dependencies'
& $pythonPath -m pip install --disable-pip-version-check --require-hashes --no-deps --no-build-isolation -r $dependencyLock
if ($LASTEXITCODE -ne 0) {
  throw "The hash-locked dependency installation failed with exit code $LASTEXITCODE."
}

Write-Host "Installing pywechat/pyweixin at commit $upstreamCommit"
& $pythonPath -m pip install --disable-pip-version-check --no-deps --no-build-isolation --force-reinstall $upstreamPackage
if ($LASTEXITCODE -ne 0) {
  throw "pyweixin installation failed with exit code $LASTEXITCODE."
}

& $pythonPath -m pip check
if ($LASTEXITCODE -ne 0) {
  throw 'The pyweixin dependency consistency check failed.'
}

& $pythonPath -c "from importlib.metadata import version; actual = version('pywechat127'); assert actual == '$upstreamVersion', actual; print('pyweixin package metadata is ready')"
if ($LASTEXITCODE -ne 0) {
  throw 'The pyweixin package metadata check failed.'
}

$sitePackages = Join-Path $environmentPath 'Lib\site-packages'
$distribution = Get-ChildItem -LiteralPath $sitePackages -Directory -Filter 'pywechat127-*.dist-info' |
  Select-Object -First 1
if ($null -eq $distribution) {
  throw 'The installed pywechat127 distribution metadata was not found.'
}
$directUrlPath = Join-Path $distribution.FullName 'direct_url.json'
$provenance = Get-Content -Raw -LiteralPath $directUrlPath | ConvertFrom-Json
if ($provenance.vcs_info.commit_id -ne $upstreamCommit) {
  throw 'The installed pywechat127 commit does not match the pinned commit.'
}

Write-Host 'WeChat Auto Reply source environment is ready.'
Write-Host "Python: $pythonPath"
