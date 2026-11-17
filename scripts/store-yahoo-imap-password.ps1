# One-time store of the Yahoo IMAP app password in Windows Credential Manager.
# Hidden prompt. The secret is never printed, logged, or placed on argv.
# Run this yourself in a local terminal (do not pipe the password to a bot):
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\store-yahoo-imap-password.ps1 -UserName 'YOUR_YAHOO_EMAIL'
param(
  [Parameter(Mandatory = $true)][string]$UserName,
  [string]$Service = 'Mailspring-offline Yahoo IMAP'
)

$ErrorActionPreference = 'Stop'
$Target = "$Service|$UserName"

$code = @'
using System;
using System.Runtime.InteropServices;

public static class OfflineSnapshotCredWrite {
  public const int CRED_TYPE_GENERIC = 1;
  public const int CRED_PERSIST_LOCAL_MACHINE = 2;

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
  public static extern bool CredWrite(ref CREDENTIAL userCredential, uint flags);

  public static void Write(string target, string userName, string secret) {
    var bytes = System.Text.Encoding.Unicode.GetBytes(secret);
    var blob = Marshal.AllocHGlobal(bytes.Length);
    try {
      Marshal.Copy(bytes, 0, blob, bytes.Length);
      var cred = new CREDENTIAL();
      cred.Type = CRED_TYPE_GENERIC;
      cred.TargetName = target;
      cred.UserName = userName;
      cred.CredentialBlobSize = bytes.Length;
      cred.CredentialBlob = blob;
      cred.Persist = CRED_PERSIST_LOCAL_MACHINE;
      if (!CredWrite(ref cred, 0)) {
        throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      }
    } finally {
      Marshal.FreeHGlobal(blob);
    }
  }
}
'@

try {
  Add-Type -TypeDefinition $code -ErrorAction Stop | Out-Null
} catch {
  if (-not ([System.Management.Automation.PSTypeName]'OfflineSnapshotCredWrite').Type) { throw }
}

$secure = Read-Host -AsSecureString "Yahoo IMAP app password (hidden, not echoed, not logged)"
if ($null -eq $secure -or $secure.Length -le 0) {
  [Console]::Error.WriteLine('store-yahoo-imap-password: empty password; nothing stored.')
  exit 1
}
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
  $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  if ([string]::IsNullOrEmpty($plain)) {
    [Console]::Error.WriteLine('store-yahoo-imap-password: empty password; nothing stored.')
    exit 1
  }
  [OfflineSnapshotCredWrite]::Write($Target, $UserName, $plain)
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  $plain = $null
  $secure = $null
}
Write-Output "Stored Credential Manager item for $UserName (secret not shown). Target=$Target"
exit 0
