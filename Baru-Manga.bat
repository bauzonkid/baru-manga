@echo off
REM Baru-Manga launcher — Vite dev server + Electron window.
REM 9router phai duoc sep tu khoi dong rieng (khong check tu dong nua).
REM Yohomin license server cung tu sep manage.

setlocal
title Baru-Manga
chcp 65001 > nul
cd /d "%~dp0"

echo ============================================================
echo  Baru-Manga - Manga Reader + AI Review
echo ============================================================
echo.
echo Yeu cau (sep tu chuan bi):
echo   - 9router chay tai http://localhost:20128
echo   - Yohomin chay tai http://localhost:3457
echo.

REM Dev override: app default endpoint la yohomin.com tunnel (production),
REM nhung trong dev minh route qua local 9router de khong ton quota tunnel.
set NINEROUTER_BASE=http://localhost:20128/v1
REM Dev license server: point vao Yohomin local (port 3457) thay vi tunnel.
set BARU_LICENSE_SERVER=http://localhost:3457
REM Dev bypass: ON => skip license gate. Comment lai de test gate that.
REM set BARU_DEV_BYPASS_LICENSE=1

cd /d "%~dp0app"
call npm run electron:dev

echo.
echo App da dong.
pause
