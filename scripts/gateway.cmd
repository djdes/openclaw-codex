@echo off
REM openclaw-codex gateway - launched by gateway-hidden.vbs (hidden window).
cd /d "C:\www\OpenClaw-Codex"
set "PATH=C:\Users\djdes\AppData\Roaming\npm;%PATH%"
"C:\Program Files\nodejs\node.exe" "C:\www\OpenClaw-Codex\src\index.js"