@echo off
setlocal
chcp 65001 >nul
pushd "%~dp0"
if exist "%~dp0.venv\Scripts\python.exe" (
    "%~dp0.venv\Scripts\python.exe" -X utf8 -B server.py
    if errorlevel 1 pause
    popd
    exit /b
)
where py.exe >nul 2>&1
if errorlevel 1 (
    python -X utf8 -B server.py
) else (
    py -3.14 -X utf8 -B server.py
)
if errorlevel 1 pause
popd
