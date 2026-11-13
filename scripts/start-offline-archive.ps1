# Windows launcher for the disconnected offline experiment.
# Mirrors scripts/start-offline-archive.sh.
#
# - Opens ONLY a local read-only mail copy (.eml tree / Maildir / mbox).
# - Isolated profile %APPDATA%\Mailspring-offline (never the official Mailspring profile).
# - No account, no mailsync, no Yahoo IMAP, no sending. Remote requests are blocked.
# - Does not read Windows Credential Manager. Gemini is never used unless a key
#   was configured separately AND you press Summarize on one selected message.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\start-offline-archive.ps1 -ArchivePath D:\Yahoo-Offline\<run>\work
param(
  [string]$ArchivePath = $env:MAILSPRING_OFFLINE_ARCHIVE_PATH,
  [switch]$Wait,
  [string]$LogFile
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Fail([string]$msg) {
  [Console]::Error.WriteLine("start-offline-archive: $msg")
  exit 1
}

$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

if (-not $ArchivePath) {
  [Console]::Error.WriteLine('start-offline-archive: pass -ArchivePath <absolute path to the WORK copy>.')
  exit 2
}
if (-not [System.IO.Path]::IsPathRooted($ArchivePath)) { Fail 'archive path must be absolute.' }
$ArchivePath = [System.IO.Path]::GetFullPath($ArchivePath).TrimEnd('\')
if (-not (Test-Path -LiteralPath $ArchivePath -PathType Container)) { Fail 'archive path is not a directory.' }
if ((Split-Path -Leaf $ArchivePath) -ieq 'baseline') { Fail 'refuses the baseline copy. Open the separate work copy.' }
$official = Join-Path $env:APPDATA 'Mailspring'
if ($ArchivePath -ieq $official -or $ArchivePath.StartsWith("$official\", [StringComparison]::OrdinalIgnoreCase)) {
  Fail 'refuses the official Mailspring profile/cache (not a backup).'
}

$Electron = Join-Path $Root 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path -LiteralPath $Electron)) { Fail 'missing Electron binary (run: node node_modules\electron\install.js).' }

# Never hand secrets or demo switches to the app from this launcher.
foreach ($name in @('MAILSPRING_DEMO_GEMINI_API_KEY', 'MAILSPRING_DEMO_GEMINI_PAID', 'MAILSPRING_DEMO',
                    'MAILSPRING_REAL_SELECTED_SUMMARY', 'YAHOO_IMAP_PASSWORD', 'IMAP_PASSWORD',
                    'MAILSPRING_IMAP_PASSWORD')) {
  if (Test-Path "Env:$name") { Remove-Item "Env:$name" }
}
$env:MAILSPRING_OFFLINE_ARCHIVE_PATH = $ArchivePath

Write-Host 'start-offline-archive: Mailspring-offline profile only. Official Mailspring is not used.'
Write-Host 'start-offline-archive: no mailsync, no Yahoo, no sending. Mail files are opened read-only.'

$argList = @('app', '--enable-logging', '--dev', '--offline-archive', "--offline-archive-path=$ArchivePath")
$quoted = $argList | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }
$startArgs = @{ FilePath = $Electron; ArgumentList = $quoted; WorkingDirectory = $Root; PassThru = $true }
if ($LogFile) {
  $startArgs['RedirectStandardOutput'] = $LogFile
  $startArgs['RedirectStandardError'] = "$LogFile.err"
}
$p = Start-Process @startArgs
Write-Host "start-offline-archive: started (pid $($p.Id))."
if ($Wait) { $p.WaitForExit() }
