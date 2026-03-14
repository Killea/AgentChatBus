@echo off
TITLE AgentChatBus Extension Builder
SETLOCAL

:: Change to the directory of this batch file
CD /D "%~dp0"

echo ========================================
echo   AgentChatBus Extension Builder
echo ========================================
echo.

:: Check for node_modules to see if we are in the right folder
IF NOT EXIST "package.json" (
    echo [ERROR] package.json not found. Please ensure this script is in the vscode-agentchatbus root folder.
    pause
    exit /b 1
)

:: Execute the PowerShell build script
echo [INFO] Starting build and packaging process...
echo.

powershell -ExecutionPolicy Bypass -File scripts\build.ps1 -bump patch

IF %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] Build failed with exit code %ERRORLEVEL%.
    pause
    exit /b %ERRORLEVEL%
)

echo.
echo [SUCCESS] Build completed successfully.
echo.
echo Press any key to close this window.
pause > nul
