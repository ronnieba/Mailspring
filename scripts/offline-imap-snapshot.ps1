# Windows launcher for the read-only Yahoo IMAP snapshot CLI.
# Mirrors scripts/offline-imap-snapshot.sh. Password is never on argv/env.
# Official Mailspring folder export is NOT this backup. Do not copy Mailspring profile/cache.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

foreach ($name in @('YAHOO_IMAP_PASSWORD', 'IMAP_PASSWORD', 'MAILSPRING_IMAP_PASSWORD')) {
  if (Test-Path "Env:$name") {
    [Console]::Error.WriteLine('offline-imap-snapshot: REFUSES password from environment. Unset it; use a hidden prompt.')
    exit 1
  }
}

if ($args.Count -eq 0) {
  [Console]::Error.WriteLine('offline-imap-snapshot: REFUSES to connect with no arguments.')
  [Console]::Error.WriteLine('  --preflight-only --username EMAIL')
  [Console]::Error.WriteLine('  --execute --dest D:\archive --username EMAIL [--work-copy D:\work]')
  [Console]::Error.WriteLine('  --password-from-keychain [--keychain-service NAME]')
  [Console]::Error.WriteLine('  --verify --dest D:\archive [--work-copy D:\work]')
  [Console]::Error.WriteLine('Yahoo TLS imap.mail.yahoo.com:993, EXAMINE / BODY.PEEK[], never STORE/SELECT.')
  [Console]::Error.WriteLine('exit 2')
  exit 2
}

foreach ($arg in $args) {
  if ($arg -eq '--password' -or $arg -eq '--imap-password' -or $arg -eq '-p' -or
      ($arg -is [string] -and ($arg.StartsWith('--password=') -or $arg.StartsWith('--imap-password=')))) {
    [Console]::Error.WriteLine('offline-imap-snapshot: REFUSES --password on argv.')
    exit 1
  }
}

Set-Location -LiteralPath $Root
$project = Join-Path $Root 'app\tsconfig.json'
$cli = Join-Path $Root 'app\src\offline-snapshot\cli.ts'
& npx --yes ts-node --project $project $cli @args
exit $LASTEXITCODE
