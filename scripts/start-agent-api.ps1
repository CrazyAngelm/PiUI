param(
    [string]$Executable = (Join-Path $env:LOCALAPPDATA 'Programs\PiUI\PiUI.exe'),
    [string]$ConnectionDirectory = (Join-Path $env:LOCALAPPDATA 'PiUI-agent-api'),
    [switch]$ClearStaleConnection
)
$ErrorActionPreference = 'Stop'
# Serialize concurrent starter clicks; the running-process guard also covers
# ordinary PiUI launches. Never terminate or attach to an existing host.
$launcherMutex = [Threading.Mutex]::new($false, ('Local\PiUI.AgentApi.Start.' + [Security.Principal.WindowsIdentity]::GetCurrent().User.Value))
$ownsMutex = $false
try {
    try { $ownsMutex = $launcherMutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $ownsMutex = $true }
    if (-not $ownsMutex) { throw 'Another PiUI API starter is already running.' }
if (Get-Process -Name 'piui-desktop', 'PiUI' -ErrorAction SilentlyContinue) {
    throw 'PiUI is already open. Close it normally before enabling the API; a second host must not share its durable store.'
}
# Cleanup is allowed only after ALL PiUI processes have exited normally.
$connectionPath = Join-Path ([IO.Path]::GetFullPath($ConnectionDirectory)) 'connection.json'
if ($ClearStaleConnection) {
    if (Test-Path -LiteralPath $connectionPath) { Remove-Item -LiteralPath $connectionPath -Force }
    @{ connectionFile = $connectionPath; cleared = $true } | ConvertTo-Json
    return
}
$resolvedExecutable = (Resolve-Path -LiteralPath $Executable).Path
if ([IO.Path]::GetFileName($resolvedExecutable) -notin @('piui-desktop.exe', 'PiUI.exe')) { throw 'Select the built piui-desktop.exe or installed PiUI.exe.' }
# Create an owner-only directory BEFORE writing the operator capability.
$directory = [IO.Path]::GetFullPath($ConnectionDirectory)
if (Test-Path -LiteralPath $directory) {
    if ((Get-Item -LiteralPath $directory).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Connection directory cannot be a reparse point.' }
} else { [IO.Directory]::CreateDirectory($directory) | Out-Null }
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = Get-Acl -LiteralPath $directory
$acl.SetAccessRuleProtection($true, $false)
foreach ($existingRule in @($acl.Access)) { $acl.RemoveAccessRuleSpecific($existingRule) }
$rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
$acl.AddAccessRule($rule)
# Persist only the modified access section; do not request an owner change. Set-Acl can also attempt to
# write the audit section, which requires SeSecurityPrivilege for a normal user.
if ($PSVersionTable.PSEdition -eq 'Core') {
    [IO.FileSystemAclExtensions]::SetAccessControl([IO.DirectoryInfo]::new($directory), $acl)
} else {
    [IO.Directory]::SetAccessControl($directory, $acl)
}
# Invalidate the previous connection only after proving no PiUI host is running.
if (Test-Path -LiteralPath $connectionPath) { Remove-Item -LiteralPath $connectionPath -Force }
# Ask the OS for an available port; host bind still fails closed if it is taken.
$probe = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$probe.Start()
$port = $probe.LocalEndpoint.Port
$probe.Stop()
$bytes = New-Object byte[] 32
$rng = [Security.Cryptography.RandomNumberGenerator]::Create()
try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
$token = [BitConverter]::ToString($bytes).Replace('-', '').ToLowerInvariant()
$connection = @{ port = $port; token = $token }
$start = [Diagnostics.ProcessStartInfo]::new($resolvedExecutable)
$start.UseShellExecute = $false
$start.WorkingDirectory = [IO.Path]::GetDirectoryName($resolvedExecutable)
$start.WindowStyle = [Diagnostics.ProcessWindowStyle]::Normal
$start.EnvironmentVariables['PIUI_AGENT_API_PORT'] = [string]$port
$start.EnvironmentVariables['PIUI_AGENT_API_TOKEN'] = $token
$process = [Diagnostics.Process]::Start($start)
# Tauri binds the API before constructing its UI. Waiting for the GUI message
# loop avoids probing before process initialization; there is no guessed timeout.
# If readiness fails, leave the started app alone and publish no stale capability.
try {
    if (-not $process.WaitForInputIdle()) { throw 'PiUI did not initialize its message loop.' }
    $client = [Net.Sockets.TcpClient]::new()
    try {
        $client.Connect([Net.IPAddress]::Loopback, $port)
        $stream = $client.GetStream()
        $writer = [IO.StreamWriter]::new($stream, [Text.UTF8Encoding]::new($false))
        $writer.NewLine = "`n"
        $writer.WriteLine($token)
        $writer.WriteLine('{"protocol":1,"method":"ping","params":{}}')
        $writer.Flush()
        $reader = [IO.StreamReader]::new($stream, [Text.UTF8Encoding]::new($false))
        $reply = $reader.ReadLine() | ConvertFrom-Json
        if ($reply.protocol -ne 1 -or -not $reply.ok -or $reply.result.api -ne 'piui-agent') { throw 'Unexpected API identity.' }
    } finally { $client.Dispose() }
    $connection.pid = $process.Id
    $connection.processStartedAt = $process.StartTime.ToUniversalTime().ToString('o')
    $pendingPath = Join-Path $directory ([guid]::NewGuid().ToString() + '.pending')
    try {
        [IO.File]::WriteAllText($pendingPath, ($connection | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
        [IO.File]::Move($pendingPath, $connectionPath)
    } finally { if (Test-Path -LiteralPath $pendingPath) { Remove-Item -LiteralPath $pendingPath -Force } }
    @{ pid = $process.Id; connectionFile = $connectionPath; readiness = 'ready'; ping = $reply.result } | ConvertTo-Json
} catch {
    throw "PiUI was started but API readiness was not confirmed. No connection file was published. Leave PID $($process.Id) alone if it has live work; close it normally when safe and use an API-capable build. $($_.Exception.Message)"
}

} finally {
    if ($ownsMutex) { $launcherMutex.ReleaseMutex() }
    $launcherMutex.Dispose()
}
