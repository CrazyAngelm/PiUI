[CmdletBinding()]
param(
    # Fail unless the installer and the portable executable carry a valid
    # Authenticode signature (set by scripts/release-build.mjs when a signing
    # certificate is configured).
    [switch]$RequireSignature
)

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
    $existing = Get-Item -LiteralPath $output -Force
    if (-not $existing.PSIsContainer -or ($existing.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
        throw "$output is not a plain directory; refusing to replace it."
    }
    Remove-Item -LiteralPath $output -Recurse -Force
}
New-Item -ItemType Directory -Path $output | Out-Null

# Cargo writes release output to CARGO_TARGET_DIR when it is set.
$targetDirectory = if ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR } else { Join-Path $root "target" }
$bundleDirectory = Join-Path $targetDirectory "release/bundle/nsis"
$installers = @(Get-ChildItem -LiteralPath $bundleDirectory -File -Filter "*_${version}_*-setup.exe")
if ($installers.Count -ne 1) {
    throw "Expected exactly one NSIS installer for version $version in $bundleDirectory; found $($installers.Count)."
}

$portableSource = Join-Path $targetDirectory "release/piui-desktop.exe"
if (-not (Test-Path -LiteralPath $portableSource -PathType Leaf)) {
    throw "Release executable is missing: $portableSource"
}

$installerDestination = Join-Path $output $installers[0].Name
$portableDestination = Join-Path $output "PiUI_${version}_windows_x86_64.exe"
Copy-Item -LiteralPath $installers[0].FullName -Destination $installerDestination
Copy-Item -LiteralPath $portableSource -Destination $portableDestination

# The updater signature exists only when the build created updater artifacts.
$updaterSignature = "$($installers[0].FullName).sig"
if (Test-Path -LiteralPath $updaterSignature -PathType Leaf) {
    Copy-Item -LiteralPath $updaterSignature -Destination "$installerDestination.sig"
    Write-Host "Update signature: $($installers[0].Name).sig"
} else {
    Write-Host "Update signature: none (updater artifacts were not enabled for this build)."
}

foreach ($binary in @($installerDestination, $portableDestination)) {
    $signature = Get-AuthenticodeSignature -LiteralPath $binary
    if ($RequireSignature -and $signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
        throw "Expected a valid Authenticode signature on $(Split-Path -Leaf $binary); status: $($signature.Status)."
    }
    Write-Host "Authenticode $(Split-Path -Leaf $binary): $($signature.Status)"
}

function Get-Sha256Hex {
    param([Parameter(Mandatory = $true)][string]$Path)

    $stream = [System.IO.File]::OpenRead($Path)
    $algorithm = [System.Security.Cryptography.SHA256]::Create()
    try {
        $digest = $algorithm.ComputeHash($stream)
        return ([System.BitConverter]::ToString($digest)).Replace("-", "").ToLowerInvariant()
    } finally {
        $algorithm.Dispose()
        $stream.Dispose()
    }
}

$releaseFiles = @(Get-ChildItem -LiteralPath $output -File | Sort-Object Name)
$checksumLines = foreach ($file in $releaseFiles) {
    $hash = Get-Sha256Hex -Path $file.FullName
    "$hash  $($file.Name)"
}
$checksumPath = Join-Path $output "SHA256SUMS.txt"
# LF line endings, so `sha256sum --check` works on every platform.
[System.IO.File]::WriteAllText($checksumPath, (($checksumLines -join "`n") + "`n"), [System.Text.UTF8Encoding]::new($false))

Write-Host "Prepared PiUI $version Windows release artifacts:"
Get-ChildItem -LiteralPath $output -File | Sort-Object Name | ForEach-Object {
    Write-Host "  $($_.Name) ($($_.Length) bytes)"
}
