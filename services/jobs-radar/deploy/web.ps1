param(
  [ValidateSet('Build','Release','Rollback','Status')][string]$Action = 'Build',
  [string]$Artifact
)
$ErrorActionPreference = 'Stop'
$releaseBash = Join-Path $env:ProgramFiles 'Git\bin\bash.exe'
if (-not (Test-Path -LiteralPath $releaseBash)) { throw 'Git for Windows Bash is required.' }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js is required.' }
$mode = @{Build='--build-web'; Release='--release-web'; Rollback='--rollback-web'; Status='--web-status'}[$Action]
$releaseArgs = @((Join-Path $PSScriptRoot 'release.sh'), $mode)
if ($Artifact) {
  if ($Action -ne 'Release') { throw '-Artifact applies only to Release.' }
  $releaseArgs += @('--artifact', (Resolve-Path -LiteralPath $Artifact).Path)
}
Push-Location (Join-Path $PSScriptRoot '..\..\..')
try {
  & $releaseBash @releaseArgs
  if ($LASTEXITCODE -ne 0) { throw "Website $Action failed (exit $LASTEXITCODE)." }
} finally { Pop-Location }
