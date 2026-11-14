@echo off
rem Double-click friendly wrapper. Usage: start-offline-archive.cmd D:\Yahoo-Offline\<run>\work
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-offline-archive.ps1" -ArchivePath "%~1"
