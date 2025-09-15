@echo off
TITLE MCP Bio Tools Server
SETLOCAL ENABLEEXTENSIONS

REM Always run from this script’s folder
cd /d "%~dp0"

REM Quick sanity checks
where node >nul 2>&1 || (echo [ERROR] Node.js not found in PATH & pause & exit /b 1)
where npm  >nul 2>&1 || (echo [ERROR] npm not found in PATH & pause & exit /b 1)

echo.
echo [INFO] Installing deps (if needed)...
IF EXIST package-lock.json (
  REM Fast if already installed; safe to re-run
  npm ci 1>nul 2>nul || echo [WARN] npm ci failed, continuing...
) ELSE (
  npm install 1>nul 2>nul || echo [WARN] npm install failed, continuing...
)

echo.
echo [INFO] Building TypeScript -> dist...
call npm run build
IF ERRORLEVEL 1 (
  echo [ERROR] Build failed. See messages above.
  pause
  exit /b 1
)

echo.
echo [INFO] Starting server on http://localhost:8788/mcp
echo [HINT] Close this window to stop the server.
echo.

REM If you prefer to run directly (skip npm script), uncomment next line and comment 'npm start'
REM node dist/bio-mcp.js

call npm start
IF ERRORLEVEL 1 (
  echo [ERROR] npm start failed.
  pause
  exit /b 1
)

echo.
echo [INFO] Server stopped.
pause

)