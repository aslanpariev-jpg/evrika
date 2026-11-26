@echo off
cd /d "%~dp0.."
call npm.cmd run build:admin
if errorlevel 1 goto failed
call npm.cmd run build:employee
if errorlevel 1 goto failed
echo Build complete. See dist\admin and dist\employee.
pause
exit /b 0
:failed
echo Build failed. See output above.
pause
exit /b 1
