@echo off
REM One-command setup for mc-headless-improved (Windows, Docker Desktop required).
setlocal
cd /d "%~dp0"

where docker >nul 2>nul
if errorlevel 1 (
  echo Docker is required: https://docs.docker.com/get-docker/
  exit /b 1
)

if not exist .env (
  copy .env.example .env >nul
  echo Created .env from .env.example.
)

docker compose up -d --build
if errorlevel 1 exit /b 1

echo.
echo Waiting for the dashboard health endpoint...
for /L %%i in (1,1,30) do (
  curl -fsS http://localhost:4202/api/health >nul 2>nul
  if not errorlevel 1 (
    echo.
    echo Dashboard is up: http://localhost:4202
    echo 1^) Create a dashboard password ^(12+ chars^).
    echo 2^) Complete Microsoft login: open the shown link, enter the code.
    echo    If the code expires, use Retry login - no restart needed.
    echo 3^) Connect to your server ^(only ones whose rules allow this^).
    exit /b 0
  )
  timeout /t 2 /nobreak >nul
)
echo Dashboard did not answer in time. Check: docker logs mc-headless
exit /b 1
