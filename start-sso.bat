@echo off
cd /d "%~dp0"
echo Looking for an old copy of Smart Storage Optimizer on port 4000...
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /R /C:":4000 .*LISTENING"') do (
  echo Stopping old copy ^(process %%p^)
  taskkill /PID %%p /F
)
echo.
echo Starting Smart Storage Optimizer...
call npm start
pause
