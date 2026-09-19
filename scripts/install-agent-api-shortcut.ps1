param(
    [string]$Executable = (Join-Path $env:LOCALAPPDATA 'Programs\PiUI\PiUI.exe'),
    [string]$ShortcutDirectory = [Environment]::GetFolderPath('Desktop')
)
$ErrorActionPreference = 'Stop'
$resolvedExecutable = (Resolve-Path -LiteralPath $Executable).Path
$starter = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'start-agent-api.ps1')).Path
$shortcutPath = Join-Path $ShortcutDirectory 'PiUI (Operator API).lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
# Retain the status window so readiness or the existing-host refusal is visible.
$shortcut.Arguments = '-NoProfile -NoExit -ExecutionPolicy Bypass -File "' + $starter + '" -Executable "' + $resolvedExecutable + '"'
$shortcut.WorkingDirectory = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$shortcut.IconLocation = $resolvedExecutable + ',0'
$shortcut.Description = 'Start PiUI with authenticated operator API; refuses a second host and verifies ping.'
$shortcut.Save()
@{ shortcut = $shortcutPath; launchesApplication = $false } | ConvertTo-Json
