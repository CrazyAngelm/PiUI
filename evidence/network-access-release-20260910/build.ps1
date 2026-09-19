$ErrorActionPreference = 'Continue'
Set-Location -LiteralPath 'D:\Projects\PIUI'
$buildStartedAt = [DateTime]::UtcNow.ToString('o')
$buildStatePath = Join-Path $PSScriptRoot 'build-state.json'
$buildLogPath = Join-Path $PSScriptRoot 'build.log'
@{ status = 'running'; pid = $PID; startedAt = $buildStartedAt } |
    ConvertTo-Json | Out-File -LiteralPath $buildStatePath -Encoding utf8
& 'C:\Users\redmi\AppData\Local\pnpm\.tools\pnpm\10.23.0\bin\pnpm.cmd' --filter @piui/desktop exec tauri build --bundles nsis --ci *> $buildLogPath
$buildExitCode = $LASTEXITCODE
@{
    status = $(if ($buildExitCode -eq 0) { 'succeeded' } else { 'failed' })
    pid = $PID
    startedAt = $buildStartedAt
    finishedAt = [DateTime]::UtcNow.ToString('o')
    exitCode = $buildExitCode
} | ConvertTo-Json | Out-File -LiteralPath $buildStatePath -Encoding utf8
exit $buildExitCode
