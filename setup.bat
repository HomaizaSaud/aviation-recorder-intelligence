@echo off
echo ================================================
echo   CVR/FDR Analyzer - Setup Script
echo ================================================

:: ── Check Docker is running ───────────────────────
docker info > nul 2>&1
if %errorlevel% neq 0 (
  echo X Docker is not running. Please start Docker Desktop and try again.
  pause
  exit /b 1
)

:: ── Create .env if it doesn't exist ──────────────
if not exist .env (
  echo Creating .env from .env.example...
  copy .env.example .env
  echo.
  echo Please fill in your HuggingFace tokens in .env then run this script again.
  echo    PYANNOTE_TOKEN, HF_TOKEN, HUGGINGFACE_TOKEN
  echo    Get yours at: https://huggingface.co/settings/tokens
  pause
  exit /b 0
)

:: ── Start containers ──────────────────────────────
echo Starting containers...
docker compose up -d --build

:: ── Wait for DB ───────────────────────────────────
echo Waiting for database to be ready...
:waitloop
docker exec cvrfdr_db pg_isready -U postgres > nul 2>&1
if %errorlevel% neq 0 (
  timeout /t 2 > nul
  goto waitloop
)
echo Database is ready!

:: ── Apply schema ──────────────────────────────────
echo Applying database schema...
docker exec -i cvrfdr_db psql -U postgres -d imported_db < server/db/schema.sql
echo Schema applied!

:: ── Done ─────────────────────────────────────────
echo.
echo ================================================
echo   CVR/FDR Analyzer is running!
echo ================================================
echo   Frontend  -^>  http://localhost:3001
echo   Backend   -^>  http://localhost:4001
echo   MinIO     -^>  http://localhost:9003
echo ================================================
echo.
echo   To stop:    docker compose down
echo   To restart: docker compose up -d
echo   To logs:    docker compose logs -f
echo.
pause
