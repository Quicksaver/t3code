@echo off
rem Windows wrapper for the Node mock peer. The peer ignores the app-server
rem argument that CodexSessionRuntime supplies, so the wrapper need not forward it.
node "%~dp0codexCollabMockPeer.mjs"
exit /b %ERRORLEVEL%
