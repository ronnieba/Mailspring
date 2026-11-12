# Read a generic Windows Credential Manager secret to stdout only (CredRead).
# Usage: windows-cred-read.ps1 -Target "Mailspring-offline Yahoo IMAP|user" -UserName "user"
# Exit 0: secret on stdout. 44: missing. 128: denied. 1: error.
# Never prints the secret to stderr, never logs it, never places it on argv.
param(
  [Parameter(Mandatory = $true)][string]$Target,
  [Parameter(Mandatory = $true)][string]$UserName
)

$ErrorActionPreference = 'Stop'
$code = @'
using System;
using System.Runtime.InteropServices;

public static class OfflineSnapshotCredRead {
  public const int CRED_TYPE_GENERIC = 1;
  public const int ERROR_NOT_FOUND = 1168;
  public const int ERROR_NO_SUCH_LOGON_SESSION = 1312;
  public const int ERROR_ACCESS_DENIED = 5;

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public int Flags;
    public int Type;
    public string TargetName;
    public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public int CredentialBlobSize;
    public IntPtr CredentialBlob;
    public int Persist;
    public int AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias;
    public string UserName;
  }

  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredRead(string target, int type, int reservedFlag, out IntPtr credentialPtr);

  [DllImport("advapi32.dll", SetLastError = true)]
  public static extern void CredFree(IntPtr cred);

  public static int Read(string target, string expectedUser, out string secret, out string reason) {
    secret = null;
    reason = null;
    IntPtr ptr;
    if (!CredRead(target, CRED_TYPE_GENERIC, 0, out ptr)) {
      int err = Marshal.GetLastWin32Error();
      if (err == ERROR_NOT_FOUND) { reason = "item could not be found"; return 44; }
      if (err == ERROR_ACCESS_DENIED || err == ERROR_NO_SUCH_LOGON_SESSION) { reason = "denied"; return 128; }
      reason = "lookup failed";
      return 1;
    }
    try {
      var cred = (CREDENTIAL)Marshal.PtrToStructure(ptr, typeof(CREDENTIAL));
      if (!string.IsNullOrEmpty(expectedUser) &&
          !string.Equals(cred.UserName, expectedUser, StringComparison.Ordinal)) {
        reason = "item could not be found";
        return 44;
      }
      if (cred.CredentialBlob == IntPtr.Zero || cred.CredentialBlobSize <= 0) {
        reason = "empty password";
        return 44;
      }
      secret = Marshal.PtrToStringUni(cred.CredentialBlob, cred.CredentialBlobSize / 2);
      if (string.IsNullOrEmpty(secret)) {
        reason = "empty password";
        return 44;
      }
      return 0;
    } finally {
      CredFree(ptr);
    }
  }
}
'@

try {
  Add-Type -TypeDefinition $code -ErrorAction Stop | Out-Null
} catch {
  if (-not ([System.Management.Automation.PSTypeName]'OfflineSnapshotCredRead').Type) {
    [Console]::Error.WriteLine('lookup failed')
    exit 1
  }
}

$secret = $null
$reason = $null
$result = [OfflineSnapshotCredRead]::Read($Target, $UserName, [ref]$secret, [ref]$reason)
if ($result -eq 0) {
  [Console]::Out.Write($secret)
  exit 0
}
if ($reason) { [Console]::Error.WriteLine($reason) }
exit $result
