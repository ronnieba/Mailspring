@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0offline-imap-snapshot.ps1" %*
exit /b %ERRORLEVEL%
