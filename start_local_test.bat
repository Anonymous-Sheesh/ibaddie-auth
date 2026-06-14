@echo off
echo Starting totp.codes server infrastructure...
echo.

cd /d "%~dp0"
cd backend

echo [*] Starting Cloudflare Worker Backend on port 8787...
start /b npx wrangler dev --port 8787

echo.
echo [*] Waiting 6 seconds for the backend to boot up...
timeout /t 6 /nobreak >nul

echo.
echo [*] Provisioning a test customer token...
for /f "tokens=* usebackq" %%F in (`powershell -Command "try { $r = Invoke-RestMethod -Uri 'http://127.0.0.1:8787/api/admin/create-token' -Method POST -Headers @{'Content-Type'='application/json'} -Body '{\"secret\":\"JBSWY3DPEHPK3PXP\", \"user\":\"TestUserLocal\"}'; $r.token } catch { echo 'Error_Could_Not_Connect' }"`) do set TOKEN=%%F

echo.
echo =========================================================================
if "%TOKEN%"=="Error_Could_Not_Connect" (
    echo [!] Backend Server may still be starting up, or Wrangler is not installed.
    echo Please make sure you have run 'npm install' in the backend folder.
) else (
    echo [SUCCESS] Token generated: %TOKEN%
    echo Previewing frontend from local file...
    powershell -Command "$path = (Get-Item '..\index.html').FullName.Replace('\', '/'); $url = 'file:///' + $path + '?token=%TOKEN%'; Start-Process $url"
)
echo =========================================================================

echo.
echo Keep this window open while you test. Close this window to kill the server.
pause
