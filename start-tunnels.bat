@echo off
echo ==========================================
echo   AEGIS DUAL-STATE ENGINE - STABLE TUNNEL
echo ==========================================
echo.
echo Starting Stable Cloudflare Tunnel on Port 8081...
echo.
echo =========================================================
echo NOTE: LOOK FOR THE URL ENDING IN ".trycloudflare.com" 
echo IGNORE ANY "CERTIFICATE POOL" WARNINGS, IT WILL WORK!
echo =========================================================
echo.

npx cloudflared tunnel --url http://localhost:8081

pause
