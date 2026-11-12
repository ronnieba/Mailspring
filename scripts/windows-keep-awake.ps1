# Process-scoped keep-awake using SetThreadExecutionState.
# Stays active until stdin closes, then clears the request. Does not change power-plan settings.
$ErrorActionPreference = 'Stop'
$code = @'
using System;
using System.Runtime.InteropServices;
public static class OfflineSnapshotExecState {
  public const uint ES_CONTINUOUS = 0x80000000;
  public const uint ES_SYSTEM_REQUIRED = 0x00000001;
  public const uint ES_DISPLAY_REQUIRED = 0x00000002;
  [DllImport("kernel32.dll")]
  public static extern uint SetThreadExecutionState(uint flags);
}
'@
try {
  Add-Type -TypeDefinition $code -ErrorAction Stop | Out-Null
} catch {
  if (-not ([System.Management.Automation.PSTypeName]'OfflineSnapshotExecState').Type) { throw }
}
[void][OfflineSnapshotExecState]::SetThreadExecutionState(0x80000007)
try {
  $stdin = [Console]::OpenStandardInput()
  $buf = New-Object byte[] 1
  while ($true) {
    $n = $stdin.Read($buf, 0, 1)
    if ($n -le 0) { break }
  }
} finally {
  [void][OfflineSnapshotExecState]::SetThreadExecutionState(0x80000000)
}
