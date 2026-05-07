#!/bin/bash

echo "================================================"
echo "  CVR/FDR Analyzer — Setup Script"
echo "================================================"

# ── Check Docker is running ───────────────────────
if ! docker info > /dev/null 2>&1; then
  echo "❌ Docker is not running. Please start Docker Desktop and try again."
  exit 1
fi

# ── Create .env if it doesn't exist ──────────────
if [ ! -f .env ]; then
  echo "📝 Creating .env from .env.example..."
  cp .env.example .env
  echo "⚠️  Please fill in your HuggingFace tokens in .env then run this script again."
  echo "   PYANNOTE_TOKEN, HF_TOKEN, HUGGINGFACE_TOKEN"
  exit 0
fi

# ── Check tokens are filled in ───────────────────
if grep -q "your_token_here" .env; then
  echo "⚠️  Please fill in your HuggingFace tokens in .env:"
  echo "   PYANNOTE_TOKEN, HF_TOKEN, HUGGINGFACE_TOKEN"
  echo "   Get yours at: https://huggingface.co/settings/tokens"
  exit 1
fi

# ── Start containers ──────────────────────────────
echo "🐳 Starting containers..."
docker compose up -d --build

# ── Wait for DB to be ready ───────────────────────
echo "⏳ Waiting for database to be ready..."
until docker exec cvrfdr_db pg_isready -U postgres > /dev/null 2>&1; do
  sleep 2
done
echo "✅ Database is ready!"

# ── Apply schema ──────────────────────────────────
echo "📦 Applying database schema..."
docker exec -i cvrfdr_db psql -U postgres -d imported_db < server/db/schema.sql
echo "✅ Schema applied!"

# ── Done ─────────────────────────────────────────
echo ""
echo "================================================"
echo "  ✅ CVR/FDR Analyzer is running!"
echo "================================================"
echo "  Frontend  →  http://localhost:3001"
echo "  Backend   →  http://localhost:4001"
echo "  MinIO     →  http://localhost:9003"
echo "================================================"
echo ""
echo "  To stop:    docker compose down"
echo "  To restart: docker compose up -d"
echo "  To logs:    docker compose logs -f"
echo ""
