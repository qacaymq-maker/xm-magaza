@echo off
title XM Magaza Cloud - Local Test
where docker >nul 2>nul
if errorlevel 1 (
 echo Docker tapilmadi. Cloud ucun DEPLOY_RAILWAY.txt faylina baxin.
 pause
 exit /b 1
)
docker compose up --build
pause
