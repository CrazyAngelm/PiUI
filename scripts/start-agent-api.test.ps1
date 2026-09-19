# Windows launcher fixture only: never starts the installed PiUI or opens app data.
$ErrorActionPreference = 'Stop'
$root = Join-Path ([IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../target'))) ('api-starter-' + [guid]::NewGuid().ToString())
[IO.Directory]::CreateDirectory($root) | Out-Null
$source = Join-Path $root 'fixture.cs'
@'
using System;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Threading;
using System.Windows.Forms;
class Fixture {
  [STAThread] static void Main() {
    var listener = new TcpListener(IPAddress.Loopback, Int32.Parse(Environment.GetEnvironmentVariable("PIUI_AGENT_API_PORT")));
    listener.Start();
    new Thread(() => {
      using(var client = listener.AcceptTcpClient()) {
        var stream = client.GetStream();
        var reader = new StreamReader(stream);
        var token = reader.ReadLine(); var request = reader.ReadLine();
        if(token != Environment.GetEnvironmentVariable("PIUI_AGENT_API_TOKEN") || !request.Contains("ping")) return;
        var writer = new StreamWriter(stream); writer.NewLine = "\n";
        writer.WriteLine("{\"protocol\":1,\"ok\":true,\"result\":{\"api\":\"piui-agent\",\"version\":1}}"); writer.Flush();
      }
      listener.Stop();
    }) { IsBackground = true }.Start();
    Application.Run();
  }
}
'@ | Set-Content -LiteralPath $source
$exe = Join-Path $root 'piui-desktop.exe'
& "$env:SystemRoot/Microsoft.NET/Framework64/v4.0.30319/csc.exe" /nologo /target:winexe /reference:System.Windows.Forms.dll "/out:$exe" $source
if ($LASTEXITCODE -ne 0) { throw 'Fixture compile failed' }
$connectionDirectory = Join-Path $root 'connection'
$starter = Join-Path $PSScriptRoot 'start-agent-api.ps1'
$fixtureProcess = $null
try {
    # Test-only discovery seam, confined to this script's scope. The executable
    # supplied below is our compiled socket fixture, not the installed host.
    function Get-Process { @() }
    $result = & $starter -Executable $exe -ConnectionDirectory $connectionDirectory | ConvertFrom-Json
    $fixtureProcess = [Diagnostics.Process]::GetProcessById($result.pid)
    if ($fixtureProcess.MainModule.FileName -ne $exe) { throw 'Unexpected fixture process' }
    $path = Join-Path $connectionDirectory 'connection.json'
    $record = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
    if ($result.readiness -ne 'ready' -or $result.ping.api -ne 'piui-agent' -or $record.pid -ne $result.pid -or -not $record.processStartedAt) { throw 'Readiness publication failed' }
    $acl = Get-Acl -LiteralPath $connectionDirectory
    if (-not $acl.AreAccessRulesProtected -or $acl.Access.Count -ne 1) { throw 'Owner-only ACL missing' }
    # Even cleanup must refuse an existing host and preserve its connection.
    function Get-Process { [pscustomobject]@{ Id = $result.pid } }
    $refused = $false
    try { & $starter -ConnectionDirectory $connectionDirectory -ClearStaleConnection } catch { $refused = $true }
    if (-not $refused -or -not (Test-Path -LiteralPath $path)) { throw 'Live-host cleanup guard failed' }
    $fixtureProcess.Kill(); $fixtureProcess.WaitForExit(); $fixtureProcess = $null
    function Get-Process { @() }
    & $starter -ConnectionDirectory $connectionDirectory -ClearStaleConnection | Out-Null
    if (Test-Path -LiteralPath $path) { throw 'Closed-host cleanup failed' }
    'PASS: authenticated ping before publication, owner ACL, live-host guard, closed-host cleanup (synthetic GUI fixture).'
} finally {
    if ($null -ne $fixtureProcess -and -not $fixtureProcess.HasExited -and $fixtureProcess.MainModule.FileName -eq $exe) { $fixtureProcess.Kill(); $fixtureProcess.WaitForExit() }
}
