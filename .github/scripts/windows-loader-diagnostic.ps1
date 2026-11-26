param(
    [string] $Executable,
    [switch] $ImportsOnly
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false

if (!$Executable) {
    $cargoLog = Join-Path $env:RUNNER_TEMP 'piui-cargo-test.log'
    if (!(Test-Path -LiteralPath $cargoLog)) {
        Write-Host 'Cargo test did not start.'
        exit 0
    }
    if (!(Select-String -LiteralPath $cargoLog -Pattern '0xc0000139|STATUS_ENTRYPOINT_NOT_FOUND' -Quiet)) {
        Write-Host 'This Cargo failure did not report STATUS_ENTRYPOINT_NOT_FOUND.'
        exit 0
    }
    $paths = Select-String -LiteralPath $cargoLog -Pattern '\(([^()]*piui_desktop_lib-[a-f0-9]+\.exe)\)'
    if (!$paths) {
        Write-Host 'Cargo did not report a piui_desktop_lib test executable.'
        exit 0
    }
    $Executable = ($paths | Select-Object -Last 1).Matches[0].Groups[1].Value
}
$Executable = (Resolve-Path -LiteralPath $Executable).Path
Write-Host "Windows $([Environment]::OSVersion.VersionString) | image $env:ImageOS $env:ImageVersion"
Write-Host "Probing $Executable"

$programs = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
$vswhere = Join-Path $programs 'Microsoft Visual Studio\Installer\vswhere.exe'
if (Test-Path -LiteralPath $vswhere) {
    $dumpbin = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -find 'VC\Tools\MSVC\**\bin\Hostx64\x64\dumpbin.exe' | Select-Object -First 1
}
if (!$dumpbin) { $dumpbin = (Get-Command dumpbin.exe -ErrorAction SilentlyContinue).Source }
if ($dumpbin) {
    $imports = & $dumpbin /nologo /imports $Executable
    if ($LASTEXITCODE -ne 0) { throw 'DUMPBIN could not read executable imports.' }

    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PiUILoaderProbe {
    [DllImport("kernel32.dll", EntryPoint = "LoadLibraryExW", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    public static extern IntPtr LoadSystemModule(string name, IntPtr reserved, uint flags);
    [DllImport("kernel32.dll", EntryPoint = "GetProcAddress", CharSet = CharSet.Ansi, ExactSpelling = true, SetLastError = true)]
    public static extern IntPtr FindName(IntPtr module, string name);
    [DllImport("kernel32.dll", EntryPoint = "GetProcAddress", ExactSpelling = true, SetLastError = true)]
    public static extern IntPtr FindOrdinal(IntPtr module, IntPtr ordinal);
    [DllImport("kernel32.dll", ExactSpelling = true)]
    public static extern bool FreeLibrary(IntPtr module);
}
'@

    $library = [IntPtr]::Zero
    $checked = 0
    $unresolved = 0
    try {
        foreach ($line in $imports) {
            if ($line.Trim() -eq 'Summary') { break }
            if ($line -match '^\s+(?<dll>[A-Za-z0-9_.-]+\.dll)\s*$') {
                if ($library -ne [IntPtr]::Zero) { [void][PiUILoaderProbe]::FreeLibrary($library) }
                $module = $Matches.dll
                # Resolve only system binaries/API-set contracts. Do not probe
                # by loading DLLs from the checkout, build directory or PATH.
                $library = [PiUILoaderProbe]::LoadSystemModule($module, [IntPtr]::Zero, 0x800)
                if ($library -eq [IntPtr]::Zero) {
                    $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
                    Write-Host ('System32 could not load {0}: Win32 {1}' -f $module, $code)
                }
                continue
            }
            if ($library -eq [IntPtr]::Zero) { continue }
            if ($line -match '^\s*(?:[0-9A-F]+\s+)*Ordinal\s+(?<ordinal>\d+)\s*$') {
                $symbol = '#' + $Matches.ordinal
                $address = [PiUILoaderProbe]::FindOrdinal($library, [IntPtr][int]$Matches.ordinal)
            } elseif ($line -match '^\s+[0-9A-F]+\s+(?<name>[^\s]+)\s*$') {
                $symbol = $Matches.name
                $address = [PiUILoaderProbe]::FindName($library, $symbol)
            } else {
                continue
            }
            $checked++
            if ($address -eq [IntPtr]::Zero) {
                $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
                $unresolved++
                Write-Host ('Unresolved import {0}!{1}: Win32 {2}' -f $module, $symbol, $code)
            }
        }
    } finally {
        if ($library -ne [IntPtr]::Zero) { [void][PiUILoaderProbe]::FreeLibrary($library) }
    }
    Write-Host "System32 imports checked: $checked; unresolved: $unresolved."
} else {
    Write-Host 'DUMPBIN unavailable. Proceeding to the loader debugger.'
}

if ($ImportsOnly) { exit 0 }

$kits = Join-Path $programs 'Windows Kits\10'
$debugTools = @(
    (Join-Path $kits 'Debuggers\x64')
    Get-ChildItem -LiteralPath (Join-Path $kits 'bin') -Directory -ErrorAction SilentlyContinue |
        ForEach-Object { Join-Path $_.FullName 'x64' }
) | Where-Object {
    (Test-Path -LiteralPath (Join-Path $_ 'cdb.exe')) -and (Test-Path -LiteralPath (Join-Path $_ 'gflags.exe'))
} | Select-Object -First 1
if (!$debugTools) {
    Write-Host 'x64 CDB/GFlags unavailable on this image.'
    exit 0
}
$cdb = Join-Path $debugTools 'cdb.exe'
$gflags = Join-Path $debugTools 'gflags.exe'
$image = Split-Path -Leaf $Executable
$log = Join-Path $env:RUNNER_TEMP 'piui-loader-snaps.log'
$env:_NT_SYMBOL_PATH = ''
& $gflags /i $image '+sls'
if ($LASTEXITCODE -ne 0) { throw 'GFlags could not enable per-executable loader snaps.' }
try {
    # --list stops at Rust's test discovery if the loader succeeds.
    & $cdb -g -G -c 'g;q' -logo $log $Executable --list *> $null
    Write-Host "CDB exit: $LASTEXITCODE"
} finally {
    & $gflags /i $image '-sls'
}
if (Test-Path -LiteralPath $log) {
    Select-String -LiteralPath $log -Pattern 'c0000139|entry point|ENTRYPOINT_NOT_FOUND|PROCEDURE_NOT_FOUND|unable to find|procedure .*could not|LdrpSnapThunk.*ERROR|Status: 0xc000' -Context 1,1 |
        ForEach-Object { $_.ToString() }
    Write-Host 'End of the loader trace:'
    Get-Content -LiteralPath $log -Tail 40
} else {
    Write-Host 'CDB did not create a loader trace.'
}
