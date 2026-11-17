# One-time store of the Gemini Developer API key (paid project "yahoo-agent")
# in Windows Credential Manager, for the offline experiment's AI panel.
# Hidden prompt. The key is never printed, logged, or placed on argv.
# Run this yourself in a local PowerShell window (do not paste the key into chat):
#   powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\Roni\Developer\Mailspring-AI-Dev\src\scripts\store-gemini-api-key.ps1"
# Remove the stored key:
#   powershell -NoProfile -ExecutionPolicy Bypass -File "...\store-gemini-api-key.ps1" -Remove
param(
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'
$Target = 'Mailspring-offline Gemini API|gemini-api-key'
$UserName = 'gemini-api-key'

if ($Remove) {
  & cmdkey.exe "/delete:$Target" | Out-Null
  if ($LASTEXITCODE -eq 0) {
    Write-Output "Removed Credential Manager item $Target"
    exit 0
  }
  Write-Output "No Credential Manager item $Target (nothing removed)"
  exit 0
}

$code = @'
using System;
using System.Runtime.InteropServices;

public static class OfflineGeminiCredWrite {
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
      cred.Comment = "Gemini Developer API key for the Mailspring offline experiment (paid project yahoo-agent)";
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
  if (-not ([System.Management.Automation.PSTypeName]'OfflineGeminiCredWrite').Type) { throw }
}

Write-Output 'Gemini Developer API key for the Mailspring offline experiment.'
Write-Output 'Use a key from the PAID Google AI Studio / Cloud project "yahoo-agent" (not a free key).'
$secure = Read-Host -AsSecureString 'Gemini API key (hidden, not echoed, not logged)'
if ($null -eq $secure -or $secure.Length -le 0) {
  [Console]::Error.WriteLine('store-gemini-api-key: empty key; nothing stored.')
  exit 1
}
$answer = Read-Host 'Is this key from the paid project yahoo-agent, and do you accept per-use charges? (y/N)'
$paid = if ($answer -match '^(y|yes)$') { '1' } else { '0' }

$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
  $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  if ([string]::IsNullOrWhiteSpace($plain)) {
    [Console]::Error.WriteLine('store-gemini-api-key: empty key; nothing stored.')
    exit 1
  }
  [OfflineGeminiCredWrite]::Write($Target, $UserName, "paid=$paid`n$($plain.Trim())")
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  $plain = $null
  $secure = $null
}
if ($paid -eq '1') {
  Write-Output "Stored (key not shown). Target=$Target. In the app's AI panel press 'Check again' or reopen the app."
} else {
  Write-Output "Stored (key not shown) WITHOUT paid confirmation; Gemini stays off. Re-run and answer y to enable."
}
exit 0
