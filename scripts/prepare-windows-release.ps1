[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$configPath = Join-Path $root "apps/desktop/src-tauri/tauri.conf.json"
$config = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
$version = [string]$config.version
if ([string]::IsNullOrWhiteSpace($version)) {
    throw "tauri.conf.json does not contain a release version."
}

# Release output is deliberately fixed under the repository. Do not accept an
# arbitrary deletion target from a caller.
$output = Join-Path $root "artifacts"
if (Test-Path -LiteralPath $output) {
    Remove-Item -LiteralPath $output -Recurse -Force
}
New-Item -ItemType Directory -Path $output | Out-Null

$bundleDirectory = Join-Path $root "target/release/bundle/nsis"
$installers = @(Get-ChildItem -LiteralPath $bundleDirectory -File -Filter "*_${version}_*-setup.exe")
if ($installers.Count -ne 1) {
    throw "Expected exactly one NSIS installer for version $version in $bundleDirectory; found $($installers.Count)."
}

$portableSource = Join-Path $root "target/release/piui-desktop.exe"
if (-not (Test-Path -LiteralPath $portableSource -PathType Leaf)) {
    throw "Release executable is missing: $portableSource"
}

$installerDestination = Join-Path $output $installers[0].Name
$portableDestination = Join-Path $output "PiUI_${version}_windows_x86_64.exe"
Copy-Item -LiteralPath $installers[0].FullName -Destination $installerDestination
Copy-Item -LiteralPath $portableSource -Destination $portableDestination

$releaseFiles = @(Get-ChildItem -LiteralPath $output -File | Sort-Object Name)
$checksumLines = foreach ($file in $releaseFiles) {
    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $file.FullName).Hash.ToLowerInvariant()
    "$hash  $($file.Name)"
}
$checksumPath = Join-Path $output "SHA256SUMS.txt"
[System.IO.File]::WriteAllLines($checksumPath, $checksumLines, [System.Text.UTF8Encoding]::new($false))

Write-Host "Prepared PiUI $version Windows release artifacts:"
Get-ChildItem -LiteralPath $output -File | Sort-Object Name | ForEach-Object {
    Write-Host "  $($_.Name) ($($_.Length) bytes)"
}
