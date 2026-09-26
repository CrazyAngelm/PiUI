$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repo = (Resolve-Path 'D:\Projects\PIUI').Path
$target = (Resolve-Path 'D:\Projects\PIUI\target').Path
if ($repo -ne 'D:\Projects\PIUI' -or $target -ne (Join-Path $repo 'target')) {
    throw 'Unexpected repository or build directory.'
}
$evidence = Join-Path $repo 'evidence\ux-audit-20260922'
$release = Get-Content -Raw -LiteralPath (Join-Path $evidence 'release-verification.json') | ConvertFrom-Json
$launch = Get-Content -Raw -LiteralPath (Join-Path $evidence 'installed-ui-verification.json') | ConvertFrom-Json
if (-not $launch.passed) { throw 'Installed application UI verification has not passed.' }
foreach ($file in @(
    $release.installedPath,
    (Join-Path $repo 'artifacts\PiUI_0.1.1_windows_x86_64.exe')
)) {
    if ((Get-FileHash -LiteralPath $file).Hash -ne $release.installedSha256) { throw "Executable hash changed: $file" }
}
if ((Get-FileHash -LiteralPath (Join-Path $repo 'artifacts\PiUI_0.1.1_x64-setup.exe')).Hash -ne $release.installerSha256) {
    throw 'Installer hash changed.'
}
foreach ($required in @('artifacts\SHA256SUMS.txt', 'evidence\ux-audit-20260922\native-proof\ux-graph-navigation.png', 'evidence\ux-audit-20260922\rollback\installed-before.exe')) {
    if (-not (Test-Path -LiteralPath (Join-Path $repo $required) -PathType Leaf)) { throw "Missing preserved artifact: $required" }
}
$buildProcesses = @(Get-CimInstance Win32_Process -Filter "name = 'cargo.exe' OR name = 'rustc.exe' OR name = 'link.exe'")
if ($buildProcesses.Count) { throw 'Build processes still exist; target directory use cannot be excluded.' }
$targetProcesses = @(Get-CimInstance Win32_Process | Where-Object {
    $_.ExecutablePath -and $_.ExecutablePath.StartsWith($target + '\', [StringComparison]::OrdinalIgnoreCase)
})
if ($targetProcesses.Count) { throw 'Processes are still running from target.' }
$pending = [Collections.Generic.Stack[string]]::new()
$pending.Push($target)
if ((Get-Item -LiteralPath $repo).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Repository is a reparse point.' }
while ($pending.Count) {
    $directory = $pending.Pop()
    if ((Get-Item -LiteralPath $directory).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Reparse point: $directory" }
    foreach ($child in Get-ChildItem -LiteralPath $directory -Force) {
        if ($child.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Reparse point: $($child.FullName)" }
        if ($child.PSIsContainer) { $pending.Push($child.FullName) }
    }
}
$before = (Get-Volume -DriveLetter D).SizeRemaining
cargo clean --target-dir $target *> (Join-Path $evidence 'build-cleanup.log')
if ($LASTEXITCODE -ne 0) { throw 'cargo clean failed.' }
if (Test-Path -LiteralPath $target) { throw 'Build directory remains after cargo clean.' }
$after = (Get-Volume -DriveLetter D).SizeRemaining
$result = [ordered]@{ target = $target; removed = $true; freeBytesBefore = $before; freeBytesAfter = $after; freeBytesIncrease = ($after - $before); verifiedAtUtc = [DateTime]::UtcNow.ToString('o') }
$json = $result | ConvertTo-Json
[IO.File]::WriteAllText((Join-Path $evidence 'build-cleanup.json'), $json, [Text.UTF8Encoding]::new($false))
$json
