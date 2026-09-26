$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repo = (Resolve-Path 'D:\Projects\PIUI').Path
$evidence = Join-Path $repo 'evidence\ux-audit-20260922'
$source = Join-Path $repo 'target\release\piui-desktop.exe'
$installer = Join-Path $repo 'target\release\bundle\nsis\PiUI_0.1.1_x64-setup.exe'
$installed = 'C:\Users\redmi\AppData\Local\Packages\OpenAI.Codex_2p2nqsd0c76g0\LocalCache\Local\PiUI\piui-desktop.exe'
$rollback = Join-Path $evidence 'rollback\installed-before.exe'
if ((Get-FileHash -LiteralPath $rollback).Hash -ne '04F75B226A50D30B6FE2B212DDE17D610C9C222FFA3CC771BD3622AA66D82F8C') {
    throw 'The verified installed rollback copy is missing or changed.'
}
$running = @(Get-CimInstance Win32_Process -Filter "name = 'piui-desktop.exe'")
if ($running.Count) { throw 'PiUI is running; preserve the current session before replacing its executable.' }
$manifest = Get-Content -Raw -LiteralPath (Join-Path $repo 'apps\desktop\dist\.vite\manifest.json') | ConvertFrom-Json
$binaryText = [Text.Encoding]::ASCII.GetString([IO.File]::ReadAllBytes($source))
$assets = @($manifest.PSObject.Properties.Value | ForEach-Object { $_.file })
foreach ($asset in $assets) {
    if (-not $binaryText.Contains($asset)) { throw "The release does not contain the current frontend asset: $asset" }
}
$binaryText = $null
$portable = Join-Path $repo 'artifacts\PiUI_0.1.1_windows_x86_64.exe'
$installerCopy = Join-Path $repo 'artifacts\PiUI_0.1.1_x64-setup.exe'
Copy-Item -LiteralPath $source -Destination $portable -Force
Copy-Item -LiteralPath $installer -Destination $installerCopy -Force
$checksums = @($portable, $installerCopy) | ForEach-Object {
    '{0}  {1}' -f (Get-FileHash -LiteralPath $_).Hash.ToLowerInvariant(), [IO.Path]::GetFileName($_)
}
[IO.File]::WriteAllLines((Join-Path $repo 'artifacts\SHA256SUMS.txt'), $checksums, [Text.UTF8Encoding]::new($false))
Copy-Item -LiteralPath $portable -Destination $installed -Force
$sourceHash = (Get-FileHash -LiteralPath $source).Hash
$portableHash = (Get-FileHash -LiteralPath $portable).Hash
$installedHash = (Get-FileHash -LiteralPath $installed).Hash
if ($sourceHash -ne $portableHash -or $sourceHash -ne $installedHash) { throw 'Release/install hash mismatch.' }
$result = [ordered]@{
    installedPath = $installed
    sourceSha256 = $sourceHash
    portableSha256 = $portableHash
    installedSha256 = $installedHash
    installerSha256 = (Get-FileHash -LiteralPath $installerCopy).Hash
    currentFrontendAssetsVerifiedInExecutable = $assets
    rollbackPath = $rollback
    packagedAtUtc = [DateTime]::UtcNow.ToString('o')
}
$json = $result | ConvertTo-Json -Depth 5
[IO.File]::WriteAllText((Join-Path $evidence 'release-verification.json'), $json, [Text.UTF8Encoding]::new($false))
$json
